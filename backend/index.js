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
const { TracebackSystem } = require('./traceback');
const { spawn } = require('child_process');
const pdfjsLib = (()=>{ try{ return require('pdfjs-dist'); }catch(_){ return null; } })();
// Optional local LLM via Ollama (no cloud). If not installed, we fall back.
let axios = null;
try { axios = require('axios'); } catch(_) { axios = null; }

const app = express();
app.use(cors());
app.use(express.json()); // For JSON body parsing
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
  // UART specifics: try to extract baud rate and TX/RX pins from free text
  if(spec.peripherals.uart){
    // Baud rate patterns (e.g., "baud rate 115200", "115200 bps", "baud: 9600")
    let baud = null;
    const baudRegexes = [
      /\bbaud(?:\s*rate)?\b[^0-9]{0,10}(\d{4,7})/i,
      /(\d{4,7})\s*(?:bps|baud)\b/i,
      /\bdefault\s*baud\b[^0-9]{0,10}(\d{4,7})/i
    ];
    for(const rx of baudRegexes){
      const m = lower.match(rx);
      if(m && m[1]){ baud = parseInt(m[1], 10); break; }
    }
    // TX/RX pin patterns (e.g., "TXD = GPIO17", "RX -> 16", "TXD0: 1", "TX on pin 17")
    let txPin = null, rxPin = null;
    const pinPatterns = [
      /\btxd?\b[^0-9a-z]{0,8}(?:gpio\s*)?(\d{1,3})/i,
      /\brxd?\b[^0-9a-z]{0,8}(?:gpio\s*)?(\d{1,3})/i,
    ];
    // Scan line-by-line to correlate TX/RX separately
    const lines = (text||'').split(/\r?\n/);
    for(const ln of lines){
      const l = ln.toLowerCase();
      const mtx = l.match(/\btxd?\b[^0-9a-z]{0,12}(?:gpio\s*)?(\d{1,3})/i);
      const mrx = l.match(/\brxd?\b[^0-9a-z]{0,12}(?:gpio\s*)?(\d{1,3})/i);
      if(!txPin && mtx && mtx[1]) txPin = parseInt(mtx[1],10);
      if(!rxPin && mrx && mrx[1]) rxPin = parseInt(mrx[1],10);
      if(txPin!=null && rxPin!=null) break;
    }
    // As a fallback, look for combined mapping like "RX=16, TX=17"
    if(rxPin==null){ const m = lower.match(/rx\s*[=:>\-]\s*(\d{1,3})/i); if(m) rxPin = parseInt(m[1],10); }
    if(txPin==null){ const m = lower.match(/tx\s*[=:>\-]\s*(\d{1,3})/i); if(m) txPin = parseInt(m[1],10); }
    // Persist if found
    if(baud){
      spec.peripherals.uart.instances = [{ name: 'UART0', baud }];
    }
    if(txPin!=null || rxPin!=null){
      spec.peripherals.uart.pins = {};
      if(txPin!=null) spec.peripherals.uart.pins.tx = txPin;
      if(rxPin!=null) spec.peripherals.uart.pins.rx = rxPin;
    }
  }
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
  if(/\badc\b/.test(lower)){ spec.peripherals.adc = spec.peripherals.adc || {}; const b = findNearbyBase('adc'); if(b) spec.peripherals.adc.base = b; }

  // Extract register name + offset pairs from lines (single-line patterns)
  const lines = (text||'').split(/\r?\n/);
  const candidates = [];
  const regMeta = {}; // name -> { reset, access, desc, fields: [] }
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
    // Capture reset/access patterns on same line
    const mra = ln.match(/\breset\b[^0-9A-Fa-f]{0,16}(0x[0-9A-Fa-f]+)/i);
    const mac = ln.match(/\baccess\b[^A-Za-z]{0,6}([A-Z\/]{1,6})/);
    if(m && (mra || mac)){
      const key = m[1];
      regMeta[key] = regMeta[key] || { fields: [] };
      if(mra) regMeta[key].reset = mra[1];
      if(mac) regMeta[key].access = mac[1];
    }
    // Try table-like rows: NAME 0xXX ... comment
    const mt = ln.match(/^\s*([A-Za-z][A-Za-z0-9_]{1,})\s+\(?(0x[0-9A-Fa-f]+)\)?/);
    if(mt){
      const rn = mt[1];
      const of = mt[2];
      candidates.push({ name: rn, offset: of });
    }
    // Bitfield lines: REG[bit] = NAME or REG.bit: NAME - DESC
    const bf1 = ln.match(/\b([A-Za-z][A-Za-z0-9_]{1,})\s*\[\s*(\d+)\s*\]\s*[:=]\s*([A-Za-z0-9_]+)(?:\s*-\s*(.*))?/);
    const bf2 = ln.match(/\b([A-Za-z][A-Za-z0-9_]{1,})\.(\d+)\s*[:=]\s*([A-Za-z0-9_]+)(?:\s*-\s*(.*))?/);
    const bfm = bf1 || bf2;
    if(bfm){
      const rname = bfm[1];
      const bit = parseInt(bfm[2], 10);
      const fname = bfm[3];
      const desc = (bfm[4]||'').trim();
      regMeta[rname] = regMeta[rname] || { fields: [] };
      regMeta[rname].fields.push({ name: fname, bit, desc });
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
  // Bucket registers by peripheral keyword
  const periphRegs = { gpio: [], uart: [], spi: [], i2c: [], adc: [], timer: [] };
  const seen = new Set();
  function bucketForName(name){
    const n = (name||'').toLowerCase();
    if(/\bgpio\b|gpio_/.test(n)) return 'gpio';
    if(/\buart\b|thr|rbr|lsr/.test(n)) return 'uart';
    if(/\bspi\b|spigcr|spibuf|spidat/.test(n)) return 'spi';
    if(/\bi2c\b|iic_?/.test(n)) return 'i2c';
    if(/\badc\b/.test(n)) return 'adc';
    if(/\btim\b|timer|tick/.test(n)) return 'timer';
    return null;
  }
  for(const r of candidates){
    const key = (r.name||'').toLowerCase();
    if(!key) continue;
    if(!seen.has(key)){
      const meta = regMeta[r.name] || {};
      spec.registers.push({ name: r.name, offset: r.offset, fields: meta.fields||[], reset: meta.reset, access: meta.access });
      const b = bucketForName(r.name);
      if(b){ periphRegs[b].push({ name: r.name, offset: r.offset, fields: meta.fields||[], reset: meta.reset, access: meta.access }); }
      seen.add(key);
    }
    if(spec.registers.length >= 128) break;
  }
  if(spec.registers.length === 0){
    spec.registers = [ { name: 'CTRL', offset: '0x00' }, { name: 'DATA', offset: '0x04' } ];
  }
  // Attach per-peripheral regs
  Object.keys(periphRegs).forEach((k)=>{
    if(periphRegs[k].length){
      spec.peripherals[k] = spec.peripherals[k] || {};
      spec.peripherals[k].regs = periphRegs[k];
    }
  });
  return spec;
}

// [REMOVED DUPLICATE FUNCTION]


// Attempt extraction via local Ollama without any external API
async function extractWithOllama(pdfText, modelName, opts){
  if(!axios) return null;
  // Default primary model and lightweight fallback for low-memory machines
  const primaryModel = (modelName || 'codellama:7b').trim();
  const fallbackModel = (process.env.OLLAMA_FALLBACK_MODEL || 'qwen2.5:1.5b').trim();
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
${pdfText.slice(0, Math.min(pdfText.length, 10000))}
"""`;
  try{
    const modelsToTry = [primaryModel];
    if(fallbackModel && fallbackModel !== primaryModel){
      modelsToTry.push(fallbackModel);
    }

    let lastErr = null;

    for(const model of modelsToTry){
      try{
        console.log(`[LLM] Requesting extraction from model: ${model} (${Math.min(pdfText.length, 10000)} chars)`);
        const resp = await axios.post(url, {
          model,
          prompt,
          stream: false,
          format: 'json',
          options: {
            temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.1,
            num_ctx: 8192
          }
        }, { timeout: 300000 }); // 5 minute timeout for slow machines

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
        lastErr = e;
        const msg = (e && e.response && e.response.data && e.response.data.error) || (e && e.message) || '';
        // If this is an out-of-memory error, and we have a fallback, try it
        if(msg.toLowerCase().includes('requires more system memory') && model !== fallbackModel){
          console.warn(`[LLM] Model "${model}" out of memory, falling back to "${fallbackModel}"`);
          continue;
        }
        // For other errors, don't keep retrying
        break;
      }
    }
    // If we reach here, all models failed
    if(lastErr){
      console.warn('[LLM] Local extraction failed:', lastErr.message || lastErr);
    }
    return null;
  }catch(e){
    // Likely Ollama not running or other fatal error
    console.warn('[LLM] Local extraction fatal error:', e && (e.message || e));
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
      // If PDF text is likely image-based, try pdftotext as a fallback extractor
      if(!textContent || textContent.trim().length < 20){
        try{
          const { spawnSync } = require('child_process');
          const pt = spawnSync('pdftotext', [file.path, '-'], { encoding: 'utf8' });
          if(pt && pt.stdout && pt.stdout.trim().length > 0){
            textContent = pt.stdout;
            req._genMeta = req._genMeta || {};
            req._genMeta.pdftotext = true;
          }
        }catch(_){}
      }
      // New: Try Python table extractor first for accurate register maps
      try{
        const tmpDir = path.join(__dirname, 'tmp', `parse_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const outJson = path.join(tmpDir, 'register_map.json');
        const py = spawn(process.env.PYTHON || 'python', [path.join(__dirname, 'parse_pdf_registers.py'), '--in', file.path, '--out', outJson], { stdio: ['ignore','pipe','pipe'] });
        let pyStdout = '';
        let pyStderr = '';
        await new Promise((resolve) => {
          py.stdout.on('data', (d)=>{ pyStdout += d.toString(); });
          py.stderr.on('data', (d)=>{ pyStderr += d.toString(); });
          py.on('close', ()=> resolve());
        });
        let parsedFromPython = null;
        try{
          if(fs.existsSync(outJson)){
            const s = JSON.parse(fs.readFileSync(outJson, 'utf8'));
            if(s && typeof s === 'object') parsedFromPython = s;
          }
        }catch(_){ parsedFromPython = null; }
        if(parsedFromPython){
          // Convert Python output shape to internal spec
          const periphMap = {};
          const regList = [];
          const perKeys = Object.keys(parsedFromPython||{});
          for(const k of perKeys){
            const arr = Array.isArray(parsedFromPython[k]) ? parsedFromPython[k] : [];
            const regs = [];
            for(const r of arr){
              if(!r || !r.name || !r.address) continue;
              const addr = String(r.address);
              regs.push({ name: r.name, offset: addr, address: addr, fields: r.fields||[], desc: r.desc });
              regList.push({ name: r.name, offset: addr, address: addr, fields: r.fields||[], desc: r.desc });
            }
            if(regs.length){ periphMap[k.toLowerCase()] = { regs }; }
          }
          parsedSpec = { name: (file.originalname||'ip').replace(/\.[^/.]+$/, ''), peripherals: periphMap, registers: regList };
          req._genMeta = req._genMeta || {};
          req._genMeta.source = 'python_tables';
        } else if(pyStderr){
          // keep going with other strategies
          req._genMeta = req._genMeta || {};
          req._genMeta.python_error = pyStderr.slice(0, 4000);
        }
        try{ fs.rmSync(tmpDir, { recursive: true, force: true }); }catch(_){}
      }catch(e){
        // non-fatal; continue to existing fallbacks
        req._genMeta = req._genMeta || {};
        req._genMeta.python_error = (e && e.message) || 'python_spawn_failed';
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

      // 4) For PDFs, do NOT rely on filename heuristics. Require actual parsed content.
      if(!parsedSpec){
        reason = reason || 'no_parsed_spec';
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

      // Validation: accept if we have meaningful structured data, even if PDF text is image-only
      const looksFirmware = isFirmwareText(textContent);
      const hasRegisters = parsedSpec && parsedSpec.registers && Array.isArray(parsedSpec.registers) && parsedSpec.registers.length >= 1;
      const per = parsedSpec && parsedSpec.peripherals || {};
      const perKeys = Object.keys(per);
      const perHasRegsOrBase = perKeys.some(k => (per[k] && ((Array.isArray(per[k].regs) && per[k].regs.length>0) || !!per[k].base)));
      const extractedStructured = !!(req._genMeta && req._genMeta.source === 'python_tables');
      // If python extracted any peripheral buckets, accept even if regs missing
      const okByStructure = (hasRegisters || perHasRegsOrBase || (extractedStructured && perKeys.length > 0));
      // Consider structural success as sufficient content for acceptance
      const okByContent = looksFirmware || extractedStructured || okByStructure;
      // Allow manual override for debugging
      const forceAccept = (req.query && String(req.query.force||'').toLowerCase() === 'true');
      if(!forceAccept && !(okByContent && okByStructure)){
        cleanFile(file.path);
        const meta = Object.assign({}, req._genMeta||{}, {
          looksFirmware,
          hasRegisters,
          perKeys,
          perHasRegsOrBase,
        });
        return res.status(400).json({ error: 'The document does not appear to be a firmware/peripheral datasheet or lacks machine-readable registers/bases.', meta });
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
    // Attach raw text and analyzed context so generator can reason from keywords
    try { parsedSpec._text = textContent || ''; } catch(_) {}
    const generatedFiles = generateFromSpec(parsedSpec, tmpDir, {});

    // Run traceback analysis automatically on every generation, with optional opt-out
    let tracebackResults = null;
    // Run traceback + AI fixes by default (original behavior), but use a smaller model for speed.
    const disableTraceback = req.query && String(req.query.traceback || '').toLowerCase() === 'false';
    if (!disableTraceback && generatedFiles.length > 0) {
      try {
        console.log('[TRACEBACK] Running error analysis on generated code...');
        const traceback = new TracebackSystem({
          // Keep compiler + static analysis on by default (can be disabled via no-compile/no-static)
          useCompiler: !(req.query && req.query['no-compile'] === 'true'),
          useStaticAnalysis: !(req.query && req.query['no-static'] === 'true'),
          // Always attempt AI fixes unless explicitly disabled, but use a lightweight model
          useAI: !(req.query && req.query['no-ai'] === 'true') && axios !== null,
          aiModel: (req.query && req.query.model) || 'qwen2.5:1.5b',
          // Always attempt to auto-fix before returning files
          autoFix: true,
          verbose: true
        });

        // Analyze generated code
        tracebackResults = await traceback.analyzeCode(tmpDir, generatedFiles);

        // Get AI fixes if errors found
        if (tracebackResults.errors.length > 0 && axios && !(req.query && req.query['no-ai'] === 'true')) {
          try {
            console.log('[TRACEBACK] Requesting AI fixes...');
            const fullPaths = generatedFiles.map(f => path.join(tmpDir, f));
            await traceback.getAIFixes(tracebackResults.errors, fullPaths);
            tracebackResults.fixes = traceback.fixes;

            // Apply fixes directly to generated files
            if (traceback.fixes && traceback.fixes.length > 0) {
              console.log('[TRACEBACK] Applying fixes to generated files...');
              const applied = await traceback.applyFixes(tmpDir, traceback.fixes);
              tracebackResults.appliedFixes = applied;
            }
          } catch (aiFixErr) {
            // Don't fail generation if AI fixes timeout or fail
            console.warn('[TRACEBACK] AI fixes failed (non-fatal):', aiFixErr.message);
            tracebackResults.aiFixError = aiFixErr.message;
          }
        }

        console.log(`[TRACEBACK] Found ${tracebackResults.errors.length} errors, ${tracebackResults.warnings.length} warnings`);
      } catch (tracebackErr) {
        console.warn('[TRACEBACK] Analysis failed:', tracebackErr.message);
        tracebackResults = { error: tracebackErr.message };
      }
    }

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
      if (tracebackResults) {
        meta.traceback = tracebackResults;
      }
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

// Traceback API endpoint - analyze code directory
app.post('/traceback', express.json(), async (req, res) => {
  const { codeDir, options = {} } = req.body;
  
  if (!codeDir || !fs.existsSync(codeDir)) {
    return res.status(400).json({ error: 'Invalid code directory' });
  }

  try {
    const traceback = new TracebackSystem({
      useCompiler: options.useCompiler !== false,
      useStaticAnalysis: options.useStaticAnalysis !== false,
      useAI: options.useAI !== false && axios !== null,
      aiModel: options.aiModel || 'codellama:7b',
      autoFix: options.autoFix || false,
      verbose: options.verbose || false
    });

    const results = await traceback.analyzeCode(codeDir);

    // Get AI fixes if enabled
    if (options.useAI !== false && results.errors.length > 0 && axios) {
      const files = fs.readdirSync(codeDir)
        .filter(f => f.endsWith('.c') || f.endsWith('.h') || f.endsWith('.cpp'))
        .map(f => path.join(codeDir, f));
      await traceback.getAIFixes(results.errors, files);
      results.fixes = traceback.fixes;
    }

    // Apply fixes if requested
    if (options.autoFix && results.fixes.length > 0) {
      const applied = await traceback.applyFixes(codeDir, results.fixes);
      results.appliedFixes = applied;
    }

    res.json(results);
  } catch (err) {
    console.error('[TRACEBACK] API error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(5000, ()=> console.log('Backend running on http://localhost:5000'));
