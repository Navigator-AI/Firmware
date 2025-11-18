# Firmware Code Generator

A complete end-to-end system that automatically generates firmware drivers from datasheet PDFs using AI and pattern recognition.

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Installation & Setup](#installation--setup)
4. [How It Works](#how-it-works)
5. [API Documentation](#api-documentation)
6. [Frontend Guide](#frontend-guide)
7. [Backend Guide](#backend-guide)
8. [Code Generation Process](#code-generation-process)
9. [Configuration](#configuration)
10. [Troubleshooting](#troubleshooting)
11. [Development](#development)

## 🎯 Overview

This system takes a datasheet PDF as input and automatically generates complete firmware drivers in C language. It uses multiple intelligent methods to extract register information, peripheral configurations, and generates production-ready code.

### LLM Configuration

**Primary LLM**: **Llama 3.1** (via Ollama)

- **Default Model**: `llama3.1`
- **LLM Framework**: [Ollama](https://ollama.ai/) (local, privacy-preserving)
- **Alternative Models**: Any Ollama-compatible model (e.g., `mistral:latest`, `llama3`, `codellama`, etc.)
- **Model Selection**: Configurable via frontend UI or API query parameter
- **Context Window**: 8192 tokens (configurable)
- **Temperature**: 0.1 (low temperature for structured extraction)

The system uses direct LLM prompting (not RAG) - the PDF text is sent directly to the LLM for structured extraction of registers and peripherals.

### Key Features
- **PDF Text Extraction**: Extracts text from datasheet PDFs
- **AI-Powered Analysis**: Uses local LLM (Ollama with Llama 3.1) for intelligent extraction
- **Pattern Recognition**: Regex-based extraction of registers and peripherals
- **Code Generation**: Creates complete C drivers with proper structure
- **Single File Output**: Consolidates all code into one downloadable file
- **Real-time Preview**: Shows generated code in browser before download

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │    Backend      │    │   Generator     │
│   (React)       │◄──►│   (Express)     │◄──►│   (Node.js)     │
│                 │    │                 │    │                 │
│ • File Upload   │    │ • PDF Processing│    │ • Code Templates│
│ • Code Preview  │    │ • AI Analysis   │    │ • Register Maps │
│ • Download ZIP  │    │ • File Generation│   │ • Driver Logic  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Components

1. **Frontend (React)**
   - File upload interface
   - Code preview with syntax highlighting
   - Download functionality
   - Model selection for AI

2. **Backend (Express.js)**
   - PDF text extraction
   - AI integration (Ollama)
   - Pattern matching
   - File generation and ZIP creation

3. **Generator (Node.js)**
   - Code template engine
   - Register mapping
   - Peripheral driver generation
   - File consolidation

## 🚀 Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- Python 3.x (for advanced PDF processing)
- Ollama (optional, for AI features)

### Step 1: Clone Repository
```bash
git clone <repository-url>
cd firmware
```

### Step 2: Install Backend Dependencies
```bash
cd backend
npm install
```

### Step 3: Install Frontend Dependencies
```bash
cd ../frontend
npm install
```

### Step 4: Install Python Dependencies (Optional)
```bash
pip install -r requirements.txt
```

### Step 5: Setup Ollama (Optional)
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama3.1
```

### Step 6: Start the Application

**Option A: Using PowerShell (Windows)**
```powershell
# Terminal 1 - Backend
cd backend
npm start

# Terminal 2 - Frontend  
cd frontend
npm start
```

**Option B: Using Command Prompt (Windows)**
```cmd
# Terminal 1 - Backend
cd backend
npm start

# Terminal 2 - Frontend
cd frontend
npm start
```

**Option C: Using Bash (Linux/Mac)**
```bash
# Terminal 1 - Backend
cd backend && npm start

# Terminal 2 - Frontend
cd frontend && npm start
```

The application will be available at:
- Frontend: http://localhost:3000
- Backend: http://localhost:5000

## 🔄 How It Works

### 1. PDF Upload & Processing
```
User uploads PDF → Backend receives file → Extract text content
```

### 2. Content Analysis (Multiple Methods)
```
Text Content → [AI Analysis | Pattern Matching | Keyword Detection] → Structured Spec
```

### 3. Code Generation
```
Structured Spec → Generator Engine → C Code Files
```

### 4. File Consolidation
```
Multiple C Files → Single Consolidated File → ZIP Download
```

## 📚 API Documentation

### POST /upload

Uploads a datasheet PDF and generates firmware code.

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Body: FormData with 'datasheet' field containing PDF file

**Query Parameters:**
- `llm` (optional): Enable AI analysis ("ollama")
- `model` (optional): Ollama model name (default: "llama3.1")
- `format` (optional): Response format ("json" for preview, default: ZIP)
- `ctx` (optional): Context window size for AI
- `temperature` (optional): AI temperature setting

**Response:**
- Success: ZIP file with generated code
- Error: JSON with error message

**Example:**
```javascript
const formData = new FormData();
formData.append('datasheet', pdfFile);

fetch('http://localhost:5000/upload?llm=ollama&model=llama3.1', {
  method: 'POST',
  body: formData
})
.then(response => response.blob())
.then(blob => {
  // Download ZIP file
});
```

## 🖥️ Frontend Guide

### File Structure
```
frontend/
├── src/
│   ├── app.jsx          # Main application component
│   ├── index.jsx        # Entry point
│   └── index.html       # HTML template
├── package.json         # Dependencies
└── dist/               # Built files
```

### Key Components

#### App Component (`app.jsx`)
Main React component handling:
- File upload
- Code preview
- Download functionality
- Model selection

#### State Management
```javascript
const [file, setFile] = useState(null);           // Selected file
const [message, setMessage] = useState('');       // Status messages
const [downloading, setDownloading] = useState(false); // Loading state
const [model, setModel] = useState('llama3.1');   // AI model
const [preview, setPreview] = useState(null);     // Generated code preview
```

#### Key Functions

**File Upload:**
```javascript
function onFileChange(e) {
  const selected = e.target.files[0];
  setFile(selected);
  setPendingFile(selected);
  setConfirmOpen(true);
}
```

**Code Generation:**
```javascript
async function upload(passedFile) {
  const formData = new FormData();
  formData.append('datasheet', selectedFile);
  
  const response = await axios.post(
    `http://localhost:5000/upload?format=json&llm=ollama&model=${model}`,
    formData,
    { responseType: 'json' }
  );
  
  if (response.data.files) {
    setPreview(response.data.files);
  }
}
```

**Download Consolidation:**
```javascript
function downloadZipFromPreview() {
  // Combines all preview files into single consolidated file
  let consolidatedContent = `/* Generated firmware drivers */`;
  
  preview.forEach(f => {
    consolidatedContent += `\n// ${f.name}\n${f.content}\n`;
  });
  
  // Create ZIP with single file
  const zip = new JSZipLib();
  zip.file(`${deviceName}_generated.c`, consolidatedContent);
  zip.generateAsync({type:'blob'}).then(blob => {
    // Download ZIP
  });
}
```

## ⚙️ Backend Guide

### File Structure
```
backend/
├── index.js            # Main server file
├── generator.js        # Code generation engine
├── package.json        # Dependencies
├── uploads/           # Temporary upload storage
└── tmp/              # Temporary file processing
```

### Main Server (`index.js`)

#### Dependencies
```javascript
const express = require('express');
const multer = require('multer');      // File upload handling
const pdf = require('pdf-parse');      // PDF text extraction
const yaml = require('js-yaml');       // YAML parsing
const xml2js = require('xml2js');      // XML parsing
const archiver = require('archiver');  // ZIP creation
const cors = require('cors');          // CORS handling
const { generateFromSpec } = require('./generator');
```

#### Upload Endpoint
```javascript
app.post('/upload', upload.single('datasheet'), async (req, res) => {
  // 1. Extract text from PDF
  // 2. Analyze content using multiple methods
  // 3. Generate code using extracted spec
  // 4. Return ZIP or JSON response
});
```

### PDF Processing Pipeline

#### 1. Text Extraction
```javascript
// Primary method: pdf-parse
const data = await pdf(dataBuffer);
let textContent = data.text;

// Fallback: pdfjs-dist
if (!textContent || textContent.length < 20) {
  const doc = await pdfjsLib.getDocument({ data: dataBuffer }).promise;
  // Extract text from all pages
}

// Advanced: Python table extraction
const py = spawn('python', ['parse_pdf_registers.py', '--in', file.path]);
```

#### 2. Content Analysis Methods

**Method 1: AI Analysis (Ollama)**
```javascript
async function extractWithOllama(pdfText, modelName, opts) {
  const prompt = `Extract structured data from datasheet:
  {
    "name": "<device_name>",
    "peripherals": { "uart": {"base":"0x4000"}, "spi": {} },
    "registers": [ {"name":"CTRL","offset":"0x00"} ]
  }`;
  
  const response = await axios.post('http://127.0.0.1:11434/api/generate', {
    model: modelName || 'llama3.1',
    prompt: prompt,
    format: 'json'
  });
  
  return JSON.parse(response.data.response);
}
```

**Method 2: Pattern Matching**
```javascript
function extractRegsAndBases(text, nameHint) {
  const lines = text.split(/\r?\n/);
  const candidates = [];
  
  for (const line of lines) {
    // Match: REGISTER_NAME offset 0x1234
    const match = line.match(/\b([A-Za-z][A-Za-z0-9_]+)\b.*?(0x[0-9A-Fa-f]+)\b/);
    if (match) {
      candidates.push({ name: match[1], offset: match[2] });
    }
  }
  
  return { registers: candidates, peripherals: detectPeripherals(text) };
}
```

**Method 3: Keyword Analysis**
```javascript
function inferSpecFromText(text, filename) {
  const scores = {
    gpio: (text.match(/\bgpio\b|pinmux|pin\s*config/g) || []).length,
    uart: (text.match(/\buart\b|\bbaud\b|\btxd\b|\brxd\b/g) || []).length,
    spi: (text.match(/\bspi\b|\bsclk\b|\bmosi\b|\bmiso\b/g) || []).length,
    i2c: (text.match(/\bi2c\b|\bsda\b|\bscl\b/g) || []).length,
  };
  
  const topPeripheral = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])[0];
    
  return { peripherals: { [topPeripheral[0]]: {} } };
}
```

## 🔧 Code Generation Process

### Generator Engine (`generator.js`)

#### Main Entry Point
```javascript
function generateFromSpec(spec, outDir, opts) {
  const peripherals = spec.peripherals || {};
  const filesCreated = [];
  
  // Generate individual peripheral files
  if (peripherals.gpio) {
    filesCreated.push(...generateGPIO(peripherals.gpio, outDir, spec));
  }
  if (peripherals.uart) {
    filesCreated.push(...generateUART(peripherals.uart, outDir, spec));
  }
  // ... other peripherals
  
  return filesCreated;
}
```

#### Peripheral Generation

**GPIO Driver Generation:**
```javascript
function generateGPIO(periph, outDir, spec) {
  const base = getHex(periph.base, '0x40010000');
  const regs = periph.regs || spec.registers || [];
  
  // Find register offsets
  const dirOff = findOffset(regs, ['gpio_dir', 'dir'], '0x00');
  const outOff = findOffset(regs, ['gpio_out', 'out'], '0x04');
  const inOff = findOffset(regs, ['gpio_in', 'in'], '0x08');
  
  // Generate header
  const header = `#ifndef GPIO_H
#define GPIO_H
#include <stdint.h>
void gpio_init(void);
void gpio_set_dir(uint32_t pin, uint8_t out);
void gpio_write(uint32_t pin, uint8_t value);
uint8_t gpio_read(uint32_t pin);
#endif`;
  
  // Generate implementation
  const implementation = `#include "gpio.h"
static volatile uint32_t *GPIO_DIR = (uint32_t*)(${base} + ${dirOff});
static volatile uint32_t *GPIO_OUT = (uint32_t*)(${base} + ${outOff});
static volatile uint32_t *GPIO_IN = (uint32_t*)(${base} + ${inOff});

void gpio_init(void) {
  *GPIO_DIR = 0x00000000; // Default: all inputs
}

void gpio_set_dir(uint32_t pin, uint8_t out) {
  if (out) *GPIO_DIR |= (1u << pin);
  else *GPIO_DIR &= ~(1u << pin);
}

void gpio_write(uint32_t pin, uint8_t value) {
  if (value) *GPIO_OUT |= (1u << pin);
  else *GPIO_OUT &= ~(1u << pin);
}

uint8_t gpio_read(uint32_t pin) {
  return ((*GPIO_IN >> pin) & 1u);
}`;
  
  // Write files
  fs.writeFileSync(path.join(outDir, 'gpio.h'), header);
  fs.writeFileSync(path.join(outDir, 'gpio.c'), implementation);
  
  return ['gpio.h', 'gpio.c'];
}
```

#### Register Definition Generation
```javascript
function emitRegisterDefines(periphKey, periph, outDir) {
  const regs = periph.regs || [];
  const base = getHex(periph.base, '0x40000000');
  
  let header = `#ifndef ${periphKey.toUpperCase()}_REGS_H
#define ${periphKey.toUpperCase()}_REGS_H
#include <stdint.h>
#define ${periphKey.toUpperCase()}_BASE (${base})`;
  
  regs.forEach(reg => {
    const name = reg.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const offset = reg.offset || '0x00';
    
    header += `\n// ${name}\n`;
    header += `#define ${name} (*((volatile uint32_t*)(${periphKey.toUpperCase()}_BASE + ${offset})))`;
    
    // Add bitfield definitions
    if (reg.fields) {
      reg.fields.forEach(field => {
        const fieldName = field.name.toUpperCase();
        const bit = field.bit;
        header += `\n#define ${name}_${fieldName} (1U << ${bit})`;
      });
    }
  });
  
  header += `\n#endif`;
  
  const filename = `${periphKey}_regs.h`;
  fs.writeFileSync(path.join(outDir, filename), header);
  return [filename];
}
```

#### Main Application Generation
```javascript
function generateMain(outDir, opts) {
  const demo = opts.demo || '';
  const wantBlink = demo === 'led_blink' || demo === '';
  const wantEcho = demo === 'uart_echo' || demo === '';
  
  const mainCode = `#include <stdint.h>
#include "board.h"
#include "platform.h"
#include "timer.h"
#include "gpio.h"
#include "uart.h"
#include "debug.h"

int main(void) {
  timer_init();
  timer_start();
  
  if (${wantBlink ? '1' : '0'}) {
    DBG_PRINT("Blink demo\\n");
    blink_demo();
  }
  
  if (${wantEcho ? '1' : '0'}) {
    uart_echo_demo();
  }
  
  while(1) {}
  return 0;
}`;
  
  fs.writeFileSync(path.join(outDir, 'main.c'), mainCode);
  return ['main.c'];
}
```

## ⚙️ Configuration

### Environment Variables
```bash
# Optional: Python path for advanced PDF processing
PYTHON=python3

# Optional: Ollama model
OLLAMA_MODEL=llama3.1

# Optional: Server port
PORT=5000
```

### Frontend Configuration
```javascript
// In app.jsx
const DEFAULT_MODEL = 'llama3.1';
const BACKEND_URL = 'http://localhost:5000';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
```

### Backend Configuration
```javascript
// In index.js
const UPLOAD_DIR = 'uploads/';
const TMP_DIR = 'tmp/';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const SUPPORTED_FORMATS = ['.pdf', '.json', '.yaml', '.xml'];
```

## 🐛 Troubleshooting

### Common Issues

#### 1. PDF Text Extraction Fails
**Problem:** PDF contains only images or scanned content
**Solution:** 
- Install Python dependencies: `pip install -r requirements.txt`
- Ensure `pdftotext` is available
- Try different PDF processing methods

#### 2. Ollama Connection Error
**Problem:** AI analysis not working
**Solution:**
```bash
# Check if Ollama is running
curl http://127.0.0.1:11434/api/tags

# Start Ollama service
ollama serve

# Pull required model
ollama pull llama3.1
```

#### 3. File Upload Issues
**Problem:** Upload fails or times out
**Solution:**
- Check file size (max 10MB)
- Ensure file is valid PDF
- Check backend server is running on port 5000

#### 4. Code Generation Errors
**Problem:** Generated code is incomplete or incorrect
**Solution:**
- Check PDF contains register tables
- Verify peripheral keywords are present
- Try different AI model
- Use manual spec upload (JSON/YAML)

### Debug Mode
Enable debug logging:
```javascript
// In backend/index.js
console.log('PDF text length:', textContent.length);
console.log('Extracted spec:', parsedSpec);
console.log('Generated files:', generatedFiles);
```

### Log Analysis
Check console output for:
- PDF processing status
- AI extraction results
- Pattern matching results
- File generation status

## 🛠️ Development

### Adding New Peripherals

1. **Add to generator.js:**
```javascript
function generateNewPeripheral(periph, outDir, spec) {
  const hname = 'new_peripheral.h';
  const cname = 'new_peripheral.c';
  
  // Generate header
  const header = `#ifndef NEW_PERIPHERAL_H
#define NEW_PERIPHERAL_H
#include <stdint.h>
void new_peripheral_init(void);
uint32_t new_peripheral_read(void);
void new_peripheral_write(uint32_t value);
#endif`;
  
  // Generate implementation
  const implementation = `#include "new_peripheral.h"
static volatile uint32_t *NEW_PERIPHERAL_REG = (uint32_t*)0x40000000;

void new_peripheral_init(void) {
  // Implementation
}

uint32_t new_peripheral_read(void) {
  return *NEW_PERIPHERAL_REG;
}

void new_peripheral_write(uint32_t value) {
  *NEW_PERIPHERAL_REG = value;
}`;
  
  fs.writeFileSync(path.join(outDir, hname), header);
  fs.writeFileSync(path.join(outDir, cname), implementation);
  
  return [hname, cname];
}
```

2. **Add to main generation:**
```javascript
if (peripherals.new_peripheral) {
  const files = generateNewPeripheral(peripherals.new_peripheral, outDir, spec);
  filesCreated.push(...files);
}
```

3. **Add pattern recognition:**
```javascript
// In extractRegsAndBases function
if (/\bnew_peripheral\b/.test(lower)) {
  spec.peripherals.new_peripheral = {};
}
```

### Adding New File Types

1. **Add to supported formats:**
```javascript
const SUPPORTED_FORMATS = ['.pdf', '.json', '.yaml', '.xml', '.txt'];
```

2. **Add processing logic:**
```javascript
} else if (ext === '.txt') {
  textContent = fs.readFileSync(file.path, 'utf8');
  parsedSpec = extractRegsAndBases(textContent, file.originalname);
}
```

### Customizing Code Templates

Modify template functions in `generator.js`:
```javascript
function generateCustomTemplate(periph, outDir, spec) {
  const template = `// Custom template for ${spec.name}
// Generated on: ${new Date().toISOString()}
// Base address: ${periph.base || '0x40000000'}

#include <stdint.h>

// Your custom code here
`;
  
  fs.writeFileSync(path.join(outDir, 'custom.c'), template);
  return ['custom.c'];
}
```

### Testing

#### Unit Tests
```bash
# Install test dependencies
npm install --save-dev jest

# Run tests
npm test
```

#### Integration Tests
```bash
# Test with sample PDF
curl -X POST -F "datasheet=@sample.pdf" http://localhost:5000/upload

# Test with JSON spec
curl -X POST -F "datasheet=@spec.json" http://localhost:5000/upload
```

### Performance Optimization

#### 1. Caching
```javascript
// Cache extracted specs
const specCache = new Map();

function getCachedSpec(fileHash) {
  return specCache.get(fileHash);
}

function setCachedSpec(fileHash, spec) {
  specCache.set(fileHash, spec);
}
```

#### 2. Parallel Processing
```javascript
// Process multiple files in parallel
const promises = files.map(file => processFile(file));
const results = await Promise.all(promises);
```

#### 3. Memory Management
```javascript
// Clean up temporary files
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.unlink(uploadedFile, () => {});
}
```

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📞 Support

For issues and questions:
- Create an issue on GitHub
- Check the troubleshooting section
- Review the API documentation

---

**Happy Coding! 🚀**
