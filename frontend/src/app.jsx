import React, {useEffect, useRef, useState} from 'react';
import hljs from 'highlight.js/lib/core';
import cLang from 'highlight.js/lib/languages/c';
import 'highlight.js/styles/atom-one-dark.css';
hljs.registerLanguage('c', cLang);
import axios from 'axios';

export default function App(){
  const [file, setFile] = useState(null);
  const fileInputRef = useRef(null);
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [model, setModel] = useState('llama3.1');

  function onFileChange(e){
    const selected = e.target.files && e.target.files[0];
    if(!selected) return;
    setFile(selected);
    setMessage('');
    setPreview(null); // clear previous preview when selecting a new file
    // Immediately upload using current demo selection
    upload(selected);
    // Allow re-selecting the same file by resetting the input value
    e.target.value = '';
  }

  async function upload(passedFile){
    const selectedFile = passedFile || file;
    if(!selectedFile){
      setMessage('Choose a file first');
      return;
    }
    // show popup confirmation
    const ok = window.confirm('Datasheet must be firmware-related (registers, UART/I2C/SPI/GPIO). Proceed?');
    if(!ok) return;

    const fd = new FormData();
    fd.append('datasheet', selectedFile);

    try{
      setDownloading(true);
      setMessage('Uploading and generating...');
      setPreview(null); // ensure old results are cleared on new upload
      const qs = `format=json&llm=ollama${model ? `&model=${encodeURIComponent(model)}` : ''}`;
      const resp = await axios.post(`http://localhost:5000/upload?${qs}`, fd, {
        responseType: 'json',
        headers: { 'Content-Type': 'multipart/form-data' },
        validateStatus: () => true
      });

      if(resp.status >= 400){
        const data = resp.data;
        setDownloading(false);
        if(data && typeof data === 'object' && data.error){
          setMessage(data.error + ' Please upload a valid firmware datasheet with register tables (REGISTER/OFFSET/ADDRESS).');
        } else {
          setMessage('Upload failed. Please upload a valid firmware datasheet with register tables.');
        }
        return;
      }

      // If server returned JSON message instead of zip (e.g. PDF validated but no spec),
      // axios will still treat as blob; attempt to parse JSON
      // Preview files if available
      if(resp.data && resp.data.files){
        const meta = resp.data.meta || {};
        const via = meta.source === 'llm' ? ` via LLM (${meta.model||model||'ollama'})` : '';
        setMessage(`Generated files ready${via}.`);
        setPreview(resp.data.files);
        setDownloading(false);
        return;
      }
      setMessage('Unexpected response.');
    }catch(err){
      console.error(err);
      if(err.response && err.response.data){
        const data = err.response.data;
        if(typeof data === 'object' && data.error){
          setMessage(data.error + ' Please upload a valid firmware datasheet with register tables (REGISTER/OFFSET/ADDRESS).');
        } else {
          try{
            const reader = new FileReader();
            reader.onload = () => setMessage((reader.result || 'Upload failed') + ' Please upload a valid firmware datasheet.');
            reader.readAsText(data);
          }catch(e){
            setMessage('Upload failed: ' + (err.message || err.toString()));
          }
        }
      }else setMessage('Upload failed: ' + (err.message || err.toString()));
    } finally {
      setDownloading(false);
    }
  }

  const [preview, setPreview] = useState(null);

  // Ensure page background stays white when scrolling
  useEffect(() => {
    const prevBg = document.body.style.backgroundColor;
    const prevMargin = document.body.style.margin;
    document.body.style.backgroundColor = '#ffffff';
    document.body.style.margin = '0';
    return () => {
      document.body.style.backgroundColor = prevBg;
      document.body.style.margin = prevMargin;
    };
  }, []);

  function downloadZipFromPreview(){
    if(!preview || !Array.isArray(preview)) return;
    // Build a zip on the client
    import('jszip')
      .then((mod) => mod && (mod.default || mod))
      .then((JSZipLib) => {
        const zip = new JSZipLib();
        preview.forEach(f => zip.file(f.name, f.content||''));
        return zip.generateAsync({type:'blob'});
      })
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (((file && file.name) ? file.name.replace(/\.[^/.]+$/, '') : 'fw')) + '_generated.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      })
      .catch((e) => setMessage('Failed to build zip: ' + (e.message||e.toString())));
  }

  return (
    <div style={{ fontFamily:'sans-serif', padding: 30, background:'#ffffff', color:'#333', minHeight:'100vh', position:'relative' }}>
      {/* Background watermark */}
      <div style={{position:'fixed', inset:0, display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'none', zIndex:0}}>
        <div style={{
          fontSize:160,
          fontWeight:800,
          letterSpacing:12,
          color:'#000',
          opacity:0.03,
          textTransform:'uppercase',
          textShadow:'0 0 18px rgba(0,0,0,0.05)'
        }}>Firmware</div>
      </div>
      <div style={{maxWidth:800, margin:'0 auto', textAlign:'center', position:'relative', zIndex:2}}>
        <h2>Embedd - Firmware Code Generator</h2>
        <p>Upload a datasheet PDF. The app validates keywords and generates skeletal drivers.</p>

        <input ref={fileInputRef} type="file" onChange={onFileChange} style={{ display:'none' }} />
        <div style={{margin:'12px', display:'flex', gap:12, justifyContent:'center'}}>
          <button onClick={() => fileInputRef.current && fileInputRef.current.click()} style={{padding:'10px 20px', background:'#6b46c1', color:'#fff', border:'none', borderRadius:6}} disabled={downloading}>
            {downloading ? 'Working...' : 'Upload Datasheet'}
          </button>
          <input
            type="text"
            placeholder="ollama model (e.g. mistral:latest)"
            value={model}
            onChange={(e)=> setModel(e.target.value)}
            style={{ padding:'10px 12px', borderRadius:6, border:'1px solid #ccc', background:'#fff', color:'#333', minWidth:260 }}
            disabled={downloading}
          />
          {/* demo dropdown removed: generation is now automatic based on parsed peripherals */}
        </div>

        <div style={{
          marginTop:20,
          color:'#333',
          background:'transparent',
          padding:12,
          borderRadius:6,
          border:'none',
          display: message ? 'block' : 'none',
          textShadow:'0 1px 2px rgba(0,0,0,0.1)'
        }}>{message}</div>

        {preview && Array.isArray(preview) && preview.length > 0 && (
          <div style={{
            marginTop:20,
            textAlign:'left',
            background:'transparent',
            border:'none',
            borderRadius:8,
            padding:14
          }}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <h3>Generated Files</h3>
              <button onClick={downloadZipFromPreview} style={{padding:'6px 12px', background:'#3182ce', color:'#fff', border:'none', borderRadius:4}}>Download ZIP</button>
            </div>
            {preview.map((f, idx) => (
              <div key={idx} style={{margin:'12px 0', background:'transparent', border:'none', borderRadius:6, padding:10}}>
                <div style={{fontWeight:'bold', marginBottom:6}}>{f.name}</div>
                <pre style={{background:'rgba(0,0,0,0.05)', color:'#333', padding:12, borderRadius:6, overflowX:'auto'}}>
                  <code className={f.name.endsWith('.c') || f.name.endsWith('.h') ? 'language-c' : ''}
                        dangerouslySetInnerHTML={{__html: (f.name.endsWith('.c')||f.name.endsWith('.h')) ? hljs.highlight(f.content, {language:'c'}).value : hljs.highlightAuto(f.content).value }} />
                </pre>
              </div>
            ))}
          </div>
        )}

        {/* usage notes removed per request */}
      </div>
    </div>
  );
}
