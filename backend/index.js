const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const yaml = require('js-yaml');
const xml2js = require('xml2js');
const archiver = require('archiver');
const cors = require('cors');
const { generateFromSpec } = require('./generator');
const pdfjsLib = (()=>{ try{ return require('pdfjs-dist'); }catch(_){ return null; } })();
// Optional local LLM via Ollama (no cloud). If not installed, we fall back.
let axios = null;
try { axios = require('axios'); } catch(_) { axios = null; }

const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });

function cleanFile(filePath){
  fs.unlink(filePath, ()=>{});
}

// Simple keyword check to validate it's firmware-related
function isFirmwareText(text){
  const keywords = ['register', 'baud', 'UART', 'I2C', 'SPI', 'GPIO', 'clock', 'interrupt', 'baudrate', 'sclk'];
  const lower = (text||'').toLowerCase();
  let found = 0;
  for(const k of keywords){
    if(lower.includes(k.toLowerCase())) found++;
  }
  return found >= 2; // configurable threshold
}

// attempt to parse machine-readable payload from text: JSON / YAML / XML
function extractSpecFromText(text){
  // Try JSON
  try{
    const m = text.match(/\{[\s\S]*\}/m);
    if(m){
      const obj = JSON.parse(m[0]);
      return obj;
    }
  }catch(e){}
  // Try YAML: using entire text parse attempt
  try{
    const obj = yaml.load(text);
    if(obj && typeof obj === 'object') return obj;
  }catch(e){}
  // Try XML: attempt parse whole text
  try{
    let parsed = null;
    xml2js.parseString(text, {explicitArray:false}, (err,res)=>{ if(!err) parsed = res;});
    if(parsed) return parsed;
  }catch(e){}
  return null;
}

// Heuristic spec inference from PDF text/filename
function inferSpecFromText(text, filename){
  const lower = (text||'').toLowerCase();
  const fname = (filename||'ip').toLowerCase();
  const name = (filename||'ip').replace(/\.[^/.]+$/, '');

  // filename hints take precedence
  if(/i2c/.test(fname)){
    return { name, peripherals: { i2c: {} } };
  }
  if(/spi/.test(fname)){
    return { name, peripherals: { spi: {} } };
  }
  if(/uart/.test(fname)){
    return { name, peripherals: { uart: { instances: [{ name:'UART0', baud:115200 }] } } };
  }
  if(/gpio/.test(fname)){
    return { name, peripherals: { gpio: { pins: 32 } } };
  }

  // score-based detection from text; pick the strongest single peripheral
  const scores = {
    gpio: (lower.match(/\bgpio\b|pinmux|pin\s*config/g)||[]).length,
    uart: (lower.match(/\buart\b|\bbaud\b|\btxd\b|\brxd\b/g)||[]).length,
    spi: (lower.match(/\bspi\b|\bsclk\b|\bmosi\b|\bmiso\b|\bcs\b/g)||[]).length,
    i2c: (lower.match(/\bi2c\b|\bsda\b|\bscl\b/g)||[]).length,
  };
  const top = Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];
  const topKey = top && top[1] > 0 ? top[0] : null;
  if(!topKey){
    // no clear match; return empty peripherals so no stale extras appear
    return { name, peripherals: {} };
  }
  if(topKey === 'uart') return { name, peripherals: { uart: { instances: [{ name:'UART0', baud:115200 }] } } };
  if(topKey === 'gpio') return { name, peripherals: { gpio: { pins: 32 } } };
  return { name, peripherals: { [topKey]: {} } };
}

// Offline heuristic extraction of bases and registers from raw text (no API)
function extractRegsAndBases(text, nameHint){
  const spec = { name: (nameHint||'ip').replace(/\.[^/.]+$/, ''), peripherals: {}, registers: [] };
  const lower = (text||'').toLowerCase();

  // Peripheral hinting by keywords
  if(/\buart\b/.test(lower)) spec.peripherals.uart = {};
  if(/\bspi\b/.test(lower)) spec.peripherals.spi = {};
  if(/\bi2c\b/.test(lower)) spec.peripherals.i2c = {};
  if(/\bgpio\b/.test(lower)) spec.peripherals.gpio = spec.peripherals.gpio || { pins: 32 };
  // Device-type classifier: analog vs digital hints
  const looksAnalog = /(transistor|pnp|npn|bjt|op-amp|opamp|analog)/.test(lower);
  if(looksAnalog){
    spec.peripherals = spec.peripherals || {};
  }

  // Try to find base addresses near mentions
  const baseRegex = /(base\s*(?:address|addr)?|address)\s*[:=]?\s*(0x[0-9a-fA-F]{6,8})/g;
  function findNearbyBase(keyword){
    const idx = lower.indexOf(keyword);
    if(idx < 0) return null;
    const win = text.slice(Math.max(0, idx-256), idx+256);
    const m = [...win.matchAll(baseRegex)][0];
    return m ? m[2] : null;
  }
  if(spec.peripherals.i2c){ const b = findNearbyBase('i2c'); if(b) spec.peripherals.i2c.base = b; }
  if(spec.peripherals.spi){ const b = findNearbyBase('spi'); if(b) spec.peripherals.spi.base = b; }
  if(spec.peripherals.uart){ const b = findNearbyBase('uart'); if(b) spec.peripherals.uart.base = b; }
  if(spec.peripherals.gpio){ const b = findNearbyBase('gpio'); if(b) spec.peripherals.gpio.base = b; }

  // Extract register name + offset pairs from lines (single-line patterns)
  const lines = (text||'').split(/\r?\n/);
  const candidates = [];
  for(const ln of lines){
    const m2 = ln.match(/\b([A-Za-z][A-Za-z0-9_]{1,})\b[^\n]{0,24}\b(?:offset|addr(?:ess)?)\b[^\n]{0,6}\b(0x[0-9A-Fa-f]+)\b/i);
    const m1 = ln.match(/\b([A-Za-z][A-Za-z0-9_]{1,})\b[^\n]{0,16}\b(0x[0-9A-Fa-f]+)\b/);
    const m = m2 || m1;
    if(m){
      const regName = m[1];
      const off = m[2];
      if(!/^table$|^chapter$/i.test(regName)){
        candidates.push({ name: regName, offset: off });
      }
    }
    // Try table-like rows: NAME 0xXX ... comment
    const mt = ln.match(/^\s*([A-Za-z][A-Za-z0-9_]{1,})\s+\(?(0x[0-9A-Fa-f]+)\)?/);
    if(mt){
      const rn = mt[1];
      const of = mt[2];
      candidates.push({ name: rn, offset: of });
    }
  }

  // Extract simple tables spanning multiple lines: look for header with keywords then rows
  const tableBlocks = [];
  const textLower = (text||'').toLowerCase();
  const headerIdx = textLower.indexOf('register');
  if(headerIdx >= 0){
    const window = (text||'').slice(Math.max(0, headerIdx-500), headerIdx + 5000);
    tableBlocks.push(window);
  }
  for(const block of tableBlocks){
    const blines = block.split(/\r?\n/).map(s=>s.trim());
    for(const l of blines){
      // NAME | OFFSET | ...  or NAME OFFSET ...
      const m = l.match(/^([A-Za-z][A-Za-z0-9_]{2,})\s+\|?\s*(?:offset|addr(?:ess)?)?\s*(0x[0-9A-Fa-f]+)\b/);
      if(m){ candidates.push({ name: m[1], offset: m[2] }); continue; }
      const m2 = l.match(/^([A-Za-z][A-Za-z0-9_]{2,})\s+(0x[0-9A-Fa-f]+)\b/);
      if(m2){ candidates.push({ name: m2[1], offset: m2[2] }); continue; }
    }
  }
  const seen = new Set();
  for(const r of candidates){
    const key = r.name.toLowerCase();
    if(!seen.has(key)){
      spec.registers.push(r);
      seen.add(key);
    }
    if(spec.registers.length >= 64) break;
  }
  if(spec.registers.length === 0){
    spec.registers = [ { name: 'CTRL', offset: '0x00' }, { name: 'DATA', offset: '0x04' } ];
  }
  return spec;
}

// Local LLM extraction via Ollama
async function extractWithOllama(pdfText, modelName, opts){
  if(!axios) return null;
  const model = modelName || 'mistral:latest';
  const genUrl = 'http://127.0.0.1:11434/api/generate';
  const chatUrl = 'http://127.0.0.1:11434/api/chat';
  const prompt = `System: Embedded-firmware assistant. Output ONLY valid JSON.
User: From this datasheet text, produce a JSON spec with optional base addresses and register offsets.
{
  "name": "<short>",
  "peripherals": { "i2c": {"base":"0x<hex>"}, "spi": {"base":"0x<hex>"}, "uart": {"base":"0x<hex>"}, "gpio": {"pins": <num>, "base":"0x<hex>"} },
  "registers": [ {"name":"CTRL","offset":"0x00"} ]
}
Text:\n"""
${pdfText.slice(0, Math.min(pdfText.length, 20000))}
"""`;
  try{
    // Attempt 1: generate with JSON mode
    const resp = await axios.post(genUrl, {
      model,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.1, num_ctx: (opts && opts.num_ctx) ? opts.num_ctx : 8192 }
    }, { timeout: 120000 });
    const body = resp && resp.data && (resp.data.response || resp.data);
    if(!body) return null;
    if(typeof body === 'string'){
      try { return JSON.parse(body); } catch(_){
        const m = body.match(/\{[\s\S]*\}/m);
        if(m){ try{ return JSON.parse(m[0]); }catch(_){ return null; } }
        return null;
      }
    }
    if(typeof body === 'object') return body;
  }catch(e1){
    try{
      // Attempt 2: generate without format
      const resp2 = await axios.post(genUrl, {
        model,
        prompt,
        stream: false,
        options: { temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.1, num_ctx: (opts && opts.num_ctx) ? opts.num_ctx : 8192 }
      }, { timeout: 120000 });
      const body2 = resp2 && resp2.data && (resp2.data.response || resp2.data);
      if(typeof body2 === 'string'){
        const m = body2.match(/\{[\s\S]*\}/m);
        if(m){ try{ return JSON.parse(m[0]); }catch(_){ /* fallthrough */ } }
      } else if(typeof body2 === 'object') {
        return body2;
      }
    }catch(e2){ /* fallthrough */ }
    try{
      // Attempt 3: chat endpoint
      const resp3 = await axios.post(chatUrl, {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      }, { timeout: 120000 });
      const body3 = resp3 && resp3.data && (resp3.data.message && resp3.data.message.content);
      if(typeof body3 === 'string'){
        const m = body3.match(/\{[\s\S]*\}/m);
        if(m){ try{ return JSON.parse(m[0]); }catch(_){ return null; } }
      }
    }catch(e3){ /* give up */ }
    return null;
  }
}

// Attempt extraction via local Ollama without any external API
async function extractWithOllama(pdfText, modelName, opts){
  if(!axios) return null;
  // Default to a widely available local model name; allow override via query
  const model = modelName || 'llama3.1';
  const url = 'http://127.0.0.1:11434/api/generate';
  const prompt = `System: You are a meticulous embedded-firmware assistant. Extract structured data only.
User: From the following PDF/datasheet text, extract a concise machine-readable spec describing peripherals and registers for driver generation. Respond with ONLY valid JSON matching this shape (no explanations, no prose, no comments):
{
  "name": "<short_name>",
  "peripherals": {
    "gpio": { "pins": <number> },
    "uart": { "instances": [{ "name": "UART0", "baud": <number> }] },
    "spi": {},
    "i2c": {}
  },
  "registers": [
    { "name": "CTRL", "offset": "0x00", "fields": [{"name":"EN","bit":0,"width":1}] }
  ]
}
Example JSON:
{"name":"I2C-ADC","peripherals":{"i2c":{}},"registers":[{"name":"CTRL","offset":"0x00","fields":[{"name":"EN","bit":0,"width":1}]}]}
Text:\n"""
${pdfText.slice(0, Math.min(pdfText.length, 60000))}
"""`;
  try{
    const resp = await axios.post(url, {
      model,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.1, num_ctx: (opts && opts.num_ctx) ? opts.num_ctx : 8192 }
    }, { timeout: 20000 });
    const body = resp && resp.data && (resp.data.response || resp.data);
    if(!body) return null;
    // Try to parse JSON from response
    if(typeof body === 'string'){
      try { return JSON.parse(body); } catch(_){}
      const m = body.match(/\{[\s\S]*\}/m);
      if(!m) return null;
      try{ return JSON.parse(m[0]); }catch(_){ return null; }
    }
    if(typeof body === 'object') return body;
    return null;
  }catch(e){
    // Likely Ollama not running or model missing
    return null;
  }
}

app.post('/upload', upload.single('datasheet'), async (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const file = req.file;
  const ext = path.extname(file.originalname).toLowerCase();
  let textContent = '';
  let parsedSpec = null;
  try{
    if(ext === '.pdf'){
      const dataBuffer = fs.readFileSync(file.path);
      let data;
      try{
        data = await pdf(dataBuffer);
      }catch(parseErr){
        console.error('PDF parse error:', parseErr);
        // Fallback to pdfjs-dist text extraction
        if(pdfjsLib && pdfjsLib.getDocument){
          try{
            const loadingTask = pdfjsLib.getDocument({ data: dataBuffer });
            const doc = await loadingTask.promise;
            let textAll = '';
            const num = doc.numPages || 0;
            for(let i=1;i<=num;i++){
              const page = await doc.getPage(i);
              const content = await page.getTextContent();
              const strings = (content && content.items) ? content.items.map(it=>it.str||'') : [];
              textAll += strings.join('\n') + '\n';
            }
            data = { text: textAll };
          }catch(e2){
            console.error('pdfjs-dist extract failed:', e2);
          }
        }
        // Fall back to filename-only heuristic to still generate a minimal skeleton
        if(!data || !data.text){
          parsedSpec = inferSpecFromText('', file.originalname);
        }
        // Continue to generation path below
        textContent = '';
        // skip the rest of PDF flow
        // no return here
      }
      if(data){
        textContent = data.text || '';
      }
      let source = 'heuristic';
      let reason = '';
      const llmRequested = !!(req.query && req.query.llm === 'ollama');
      // 1) If user requests local LLM, try it FIRST
      if(!parsedSpec && llmRequested && axios){
        try{
          const model = (req.query.model || '').trim() || undefined;
          const num_ctx = req.query && req.query.ctx ? parseInt(req.query.ctx, 10) : undefined;
          const temperature = req.query && req.query.temperature ? parseFloat(req.query.temperature) : undefined;
          console.log('[LLM] Attempting local extraction via Ollama model=', model || '(default)');
          const llmSpec = await extractWithOllama(textContent, model, { num_ctx, temperature });
          if(llmSpec && typeof llmSpec === 'object'){
            parsedSpec = llmSpec;
            source = 'llm';
            console.log('[LLM] Extraction succeeded');
          }
        }catch(e){
          reason = 'ollama_error';
          console.error('[LLM] Extraction failed:', e && (e.message||e));
        }
      }

      // 2) Try structured JSON/YAML/XML in text (datasheets that embed JSON)
      if(!parsedSpec){
        try{
          const extracted = extractSpecFromText(textContent);
          if(extracted && typeof extracted === 'object'){
            parsedSpec = extracted;
            if(source === 'heuristic') source = 'embedded';
          }
        }catch(e){ /* ignore */ }
      }

      // 3) Try offline regex-based extraction next
      if(!parsedSpec){
        try{
          const rx = extractRegsAndBases(textContent, file.originalname);
          if(rx && typeof rx === 'object'){
            parsedSpec = rx;
            if(source === 'heuristic' || source === 'embedded') source = 'regex';
          }
        }catch(e){ reason = 'regex_error'; }
      }

      // 4) Heuristic filename/text fallback (last resort)
      if(!parsedSpec){
        parsedSpec = inferSpecFromText(textContent, file.originalname);
        if(!parsedSpec) reason = reason || 'no_keywords_found';
      }

      // attach meta for client visibility
      req._genMeta = req._genMeta || {};
      req._genMeta.source = parsedSpec ? (source || 'heuristic') : 'none';
      if(source === 'llm' && req.query && req.query.model) req._genMeta.model = req.query.model;
      if(reason) req._genMeta.reason = reason;
      if(!parsedSpec){
        // As a final fallback, infer from text
        parsedSpec = inferSpecFromText(textContent, file.originalname);
      }

      // Strict validation: if it doesn't look like a firmware datasheet and we only inferred heuristically, stop
      const looksFirmware = isFirmwareText(textContent);
      const hasRegisters = parsedSpec && parsedSpec.registers && Array.isArray(parsedSpec.registers) && parsedSpec.registers.length >= 2;
      const hasPeripherals = parsedSpec && parsedSpec.peripherals && Object.keys(parsedSpec.peripherals).length > 0;
      if(!looksFirmware && req._genMeta.source === 'heuristic' && !hasRegisters){
        cleanFile(file.path);
        return res.status(400).json({ error: 'The document does not appear to be a firmware/peripheral datasheet. No registers or machine-readable spec were found.' , meta: req._genMeta });
      }
    } else if(ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.xml'){
      textContent = fs.readFileSync(file.path, 'utf8');
      if(ext === '.json'){
        parsedSpec = JSON.parse(textContent);
      } else if(ext === '.yaml' || ext === '.yml'){
        parsedSpec = yaml.load(textContent);
      } else if(ext === '.xml'){
        parsedSpec = await new Promise((resolve, reject)=>{
          xml2js.parseString(textContent, {explicitArray:false}, (err,res)=> err ? reject(err) : resolve(res));
        });
      }
      // do a minimal sanity check
      if(!parsedSpec || typeof parsedSpec !== 'object'){
        cleanFile(file.path);
        return res.status(400).json({ error: 'Uploaded spec could not be parsed or is empty.' });
      }
      // quick firmware text check on raw content
      if(!isFirmwareText(textContent)){
        // still allow — maybe spec is compact; warn instead
        console.warn('Warning: uploaded spec did not pass keyword check.');
      }
    } else {
      cleanFile(file.path);
      return res.status(400).json({ error: 'Unsupported file type. Accepts PDF / JSON / YAML / XML.' });
    }

    // At this point we have parsedSpec (object) OR we returned earlier for PDF needing machine-readable spec.
    if(!parsedSpec){
      cleanFile(file.path);
      return res.status(500).json({ error: 'Failed to extract spec from uploaded file.' });
    }

    // Minimal normalization (no artificial peripherals)
    try{ if(!parsedSpec.name) parsedSpec.name = (file.originalname||'ip').replace(/\.[^/.]+$/, ''); }catch(_){}

    // Generate code files in a temporary folder
    const tmpDir = path.join(__dirname, 'tmp', Date.now().toString());
    fs.mkdirSync(tmpDir, { recursive: true });
    const generatedFiles = generateFromSpec(parsedSpec, tmpDir);

    // If client requests JSON, return generated files inline for preview
    if ((req.query && req.query.format === 'json')){
      const filesPayload = generatedFiles.map((fname) => {
        const fpath = path.join(tmpDir, fname);
        let content = '';
        try { content = fs.readFileSync(fpath, 'utf8'); } catch(e) { content = ''; }
        return { name: fname, content };
      });
      cleanFile(file.path);
      // Cleanup tmp in background
      setTimeout(() => { try{ fs.rmSync(tmpDir, { recursive: true, force: true }); }catch(e){} }, 1000 * 10);
      const meta = req._genMeta || {};
      return res.status(200).json({ files: filesPayload, meta });
    }

    // Default: stream zip directly to response to avoid race conditions with temp files
    const zipName = `fwgen_${Date.now()}.zip`;
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Disposition', `attachment; filename=${zipName}`);
    res.setHeader('Content-Type', 'application/zip');

    // When response finishes, cleanup temp dir
    const scheduleCleanup = () => {
      // cleanup uploaded file and tmp contents after response
      try { cleanFile(file.path); } catch(e) {}
      setTimeout(() => {
        try{ fs.rmSync(tmpDir, { recursive: true, force: true }); }catch(e){}
      }, 1000 * 10);
    };

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      try { res.status(500).json({ error: 'Failed to create archive: ' + (err.message||err) }); } catch(e) {}
      scheduleCleanup();
    });

    archive.pipe(res);
    for(const f of generatedFiles){
      const fpath = path.join(tmpDir, f);
      archive.file(fpath, { name: path.basename(f) });
    }
    archive.finalize().then(() => {
      // res will end when archive stream finishes
      scheduleCleanup();
    }).catch((e) => {
      console.error('Finalize error:', e);
      try { res.status(500).json({ error: 'Failed to finalize archive: ' + (e.message||e) }); } catch(_) {}
      scheduleCleanup();
    });

  } catch(err){
    console.error(err);
    cleanFile(file.path);
    return res.status(500).json({ error: 'Server error: ' + (err.message||err) });
  }
});

app.listen(5000, ()=> console.log('Backend running on http://localhost:5000'));
