# Firmware Code Generator

A complete end-to-end system that automatically generates firmware drivers from datasheet PDFs using AI and pattern recognition.

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Installation & Setup](#installation--setup)
4. [Project Dependencies](#-project-dependencies)
5. [How It Works](#how-it-works)
6. [API Documentation](#api-documentation)
7. [Frontend Guide](#frontend-guide)
8. [Backend Guide](#backend-guide)
9. [Code Generation Process](#code-generation-process)
10. [Configuration](#configuration)
11. [Troubleshooting](#troubleshooting)
12. [Development](#development)

## 🎯 Overview

This system takes a datasheet PDF as input and automatically generates complete firmware drivers in C language. It uses multiple intelligent methods to extract register information, peripheral configurations, and generates production-ready code.

### LLM Configuration

**Primary LLM**: **Code Llama 7B** (via Ollama) for higher code accuracy

- **Default Model**: `codellama:7b`
- **LLM Framework**: [Ollama](https://ollama.ai/) (local, privacy-preserving)
- **Alternative Models**: Any Ollama-compatible model (e.g., `mistral:latest`, `llama3`, `codellama:13b`, etc.)
- **Model Selection**: Configurable via frontend UI or API query parameter
- **Context Window**: 8192 tokens (configurable)
- **Temperature**: 0.1 (low temperature for structured extraction)

The system uses direct LLM prompting (not RAG) - the PDF text is sent directly to the LLM for structured extraction of registers and peripherals.

### Key Features
- **PDF Text Extraction**: Extracts text from datasheet PDFs
- **AI-Powered Analysis**: Uses local LLM (Ollama with Code Llama 7B) for intelligent extraction
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
│ • Download ZIP  │    │ • FileGeneration│    │ • Driver Logic  │
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

# Pull Code Llama 7B for better code accuracy
ollama pull codellama:7b
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

## 📦 Project Dependencies

This section explains what each dependency does in the codebase and where it's used.

### Backend Dependencies

#### 1. **archiver** (v5.3.1)
- **Purpose**: Creates ZIP archives of generated firmware files
- **Where Used**: `backend/index.js` (lines 8, 638-663)
- **What It Does**:
  - Creates a ZIP stream from multiple generated C files
  - Streams the ZIP directly to the HTTP response for download
  - Used when users download generated code (default response format)
  - Code example:
    ```javascript
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);  // Streams zip to HTTP response
    archive.file(fpath, { name: path.basename(f) });  // Adds each file
    archive.finalize();  // Completes the zip
    ```

#### 2. **express** (v4.18.2)
- **Purpose**: Web server framework for Node.js
- **Where Used**: `backend/index.js` (lines 1, 17, 391, 679)
- **What It Does**:
  - Creates the Express application instance (`const app = express()`)
  - Handles the `/upload` POST endpoint for file uploads
  - Listens on port 5000 for incoming requests
  - Provides routing and middleware functionality
  - Code: `app.post('/upload', ...)` defines the upload route

#### 3. **multer** (v1.4.5-lts.2)
- **Purpose**: Handles multipart/form-data file uploads
- **Where Used**: `backend/index.js` (lines 2, 19, 391)
- **What It Does**:
  - Processes file uploads from the frontend FormData
  - Saves uploaded files temporarily to `uploads/` directory
  - Provides `req.file` object with file metadata (name, path, size)
  - Code: `upload.single('datasheet')` middleware handles the file upload field

#### 4. **pdf-parse** (v1.1.1)
- **Purpose**: Extracts text content from PDF files
- **Where Used**: `backend/index.js` (lines 5, 402)
- **What It Does**:
  - Primary method for PDF text extraction from uploaded datasheets
  - Parses PDF buffer and extracts readable text content
  - Used to analyze PDF content for register and peripheral information
  - Code: `data = await pdf(dataBuffer)` extracts text from PDF buffer

#### 5. **js-yaml** (v4.1.0)
- **Purpose**: Parses YAML configuration files
- **Where Used**: `backend/index.js` (lines 6, 48, 584)
- **What It Does**:
  - Parses YAML/yml spec files uploaded by users
  - Also attempts YAML extraction from PDF text content
  - Converts YAML format to JavaScript objects
  - Code: `yaml.load(textContent)` converts YAML to JavaScript objects

#### 6. **xml2js** (v0.4.23)
- **Purpose**: Parses XML files and converts them to JavaScript objects
- **Where Used**: `backend/index.js` (lines 7, 54, 586-588)
- **What It Does**:
  - Parses XML spec files uploaded by users
  - Attempts XML extraction from PDF text content
  - Converts XML structure to JavaScript objects for processing
  - Code: `xml2js.parseString(textContent, ...)` parses XML asynchronously

#### 7. **cors** (v2.8.5)
- **Purpose**: Enables Cross-Origin Resource Sharing (CORS)
- **Where Used**: `backend/index.js` (lines 9, 18)
- **What It Does**:
  - Allows the frontend (running on port 4000/3000) to make requests to the backend (port 5000)
  - Prevents CORS browser security errors
  - Enables cross-origin requests from the React frontend
  - Code: `app.use(cors())` enables CORS for all routes

#### 8. **axios** (v1.6.8) - *Also used in backend*
- **Purpose**: HTTP client for making API requests
- **Where Used**: `backend/index.js` (line 15, 290-337)
- **What It Does**:
  - Makes HTTP POST requests to local Ollama LLM service
  - Sends PDF text to Ollama for AI-powered extraction
  - Handles responses from Ollama API at `http://127.0.0.1:11434`
  - Code: `axios.post('http://127.0.0.1:11434/api/generate', {...})`

#### 9. **pdfjs-dist** (v4.7.76) - *Additional backend dependency*
- **Purpose**: Alternative PDF text extraction library
- **Where Used**: `backend/index.js` (lines 12, 406-421)
- **What It Does**:
  - Fallback method when `pdf-parse` fails to extract text
  - More robust PDF parsing for complex PDFs
  - Extracts text from all pages of the PDF
  - Code: `pdfjsLib.getDocument({ data: dataBuffer })` loads PDF for text extraction

### Frontend Dependencies

#### 10. **axios** (v1.4.0)
- **Purpose**: HTTP client for making API requests from the browser
- **Where Used**: `frontend/src/app.jsx` (lines 6, 45)
- **What It Does**:
  - Sends POST requests to the backend `/upload` endpoint
  - Handles file uploads with FormData
  - Manages response and error handling
  - Code: `axios.post('http://localhost:5000/upload?...', fd, {...})`

#### 11. **highlight.js** (v11.9.0)
- **Purpose**: Syntax highlighting for code preview
- **Where Used**: `frontend/src/app.jsx` (lines 2-5, 247)
- **What It Does**:
  - Highlights generated C code in the preview panel
  - Registers C language support for syntax highlighting
  - Applies color coding to make code more readable
  - Code: `hljs.highlight(f.content, {language:'c'})` highlights C code

#### 12. **jszip** (v3.10.1)
- **Purpose**: Creates ZIP files in the browser
- **Where Used**: `frontend/src/app.jsx` (lines 164-181)
- **What It Does**:
  - Creates ZIP files client-side for download
  - Consolidates all generated files into a single ZIP archive
  - Used when downloading from the preview panel
  - Code: Creates JSZip instance, adds files, generates blob for download

#### 13. **react** (v18.2.0)
- **Purpose**: JavaScript library for building user interfaces
- **Where Used**: `frontend/src/app.jsx`, `frontend/src/index.jsx`
- **What It Does**:
  - Builds the entire frontend UI components
  - Manages component state (file, model, preview, messages)
  - Handles user interactions and UI updates
  - Code: `import React, {useState, useEffect} from 'react'`

#### 14. **react-dom** (v18.2.0)
- **Purpose**: React package for DOM rendering
- **Where Used**: `frontend/src/index.jsx` (line 2)
- **What It Does**:
  - Renders React components to the browser DOM
  - Provides the `createRoot` API for React 18
  - Code: `createRoot(...).render(<App />)` mounts the app to DOM

### Frontend Dev Dependencies

#### 15. **buffer** (v6.0.3)
- **Purpose**: Node.js Buffer polyfill for browser environments
- **Where Used**: Used by Parcel bundler and other build tools
- **What It Does**:
  - Provides Node.js Buffer API in browser environments
  - Required by some npm packages that expect Node.js APIs
  - Enables compatibility between Node.js and browser code

#### 16. **parcel** (v2.9.3)
- **Purpose**: Web application bundler and development server
- **Where Used**: `frontend/package.json` scripts
- **What It Does**:
  - Bundles React application for production
  - Serves development server on port 4000
  - Handles hot module replacement (HMR) for development
  - Code: `parcel src/index.html --port 4000` starts dev server

#### 17. **process** (v0.11.10)
- **Purpose**: Node.js process polyfill for browser environments
- **Where Used**: Used by Parcel and other build tools
- **What It Does**:
  - Provides `process.env` and other Node.js process APIs in browser
  - Required by some npm packages that expect Node.js environment
  - Enables environment variable access in browser code

### Dependency Summary

**Backend Core:**
- `express` - Web server
- `multer` - File upload handling
- `cors` - Cross-origin requests

**File Processing:**
- `pdf-parse` - Primary PDF text extraction
- `pdfjs-dist` - Fallback PDF extraction
- `js-yaml` - YAML parsing
- `xml2js` - XML parsing

**Output Generation:**
- `archiver` - ZIP file creation

**AI Integration:**
- `axios` - HTTP client for Ollama API

**Frontend Core:**
- `react` + `react-dom` - UI framework
- `axios` - HTTP client
- `highlight.js` - Code syntax highlighting
- `jszip` - Client-side ZIP creation

**Development Tools:**
- `parcel` - Build tool and dev server
- `buffer` + `process` - Browser polyfills

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
- `model` (optional): Ollama model name (default: "codellama:7b")
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

fetch('http://localhost:5000/upload?llm=ollama&model=codellama:7b', {
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
const [model, setModel] = useState('codellama:7b');   // AI model
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
    model: modelName || 'codellama:7b',
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
OLLAMA_MODEL=codellama:7b

# Optional: Server port
PORT=5000
```

### Frontend Configuration
```javascript
// In app.jsx
const DEFAULT_MODEL = 'codellama:7b';
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

## 🔍 Traceback System

The traceback system automatically detects and fixes errors in generated firmware code. It provides both a CLI tool and API integration.

### Features

- **Compilation Error Detection**: Attempts to compile code and catches compilation errors
- **Static Analysis**: Uses cppcheck and clang-tidy for code quality checks
- **Syntax Validation**: Detects common syntax errors (missing semicolons, unclosed brackets, etc.)
- **AI-Powered Fixes**: Uses Ollama LLM to suggest automatic fixes for errors
- **Code Quality Checks**: Identifies potential issues like uninitialized variables

### CLI Usage

```bash
# Basic analysis
node backend/traceback-cli.js <code-directory>

# With automatic fixes
node backend/traceback-cli.js <code-directory> --fix

# Skip compilation checks (faster)
node backend/traceback-cli.js <code-directory> --no-compile

# Skip static analysis
node backend/traceback-cli.js <code-directory> --no-static

# Skip AI fixes
node backend/traceback-cli.js <code-directory> --no-ai

# Use specific AI model
node backend/traceback-cli.js <code-directory> --model codellama:13b

# Verbose output
node backend/traceback-cli.js <code-directory> --verbose
```

### Using npm script

```bash
npm run traceback <code-directory> [options]
```

### Example Output

```
🔍 Starting traceback analysis...

📁 Analyzing: /path/to/generated/code
⚙️  Options: { autoFix: false, useCompiler: true, ... }

================================================================================
🔍 TRACEBACK ANALYSIS REPORT
================================================================================

❌ ERRORS (2):
--------------------------------------------------------------------------------

[1] gpio.c:15:5
    Type: compilation
    Message: 'GPIO_BASE' undeclared (first use in this function)
    Code: static volatile uint32_t *GPIO_DIR = (uint32_t*)(GPIO_BASE + 0x00);

[2] uart.c:23:10
    Type: syntax
    Message: Missing semicolon or closing brace
    Code: void uart_init(void) {

⚠️  WARNINGS (1):
--------------------------------------------------------------------------------

[1] gpio.c:8:3
    Type: quality
    Message: Potentially uninitialized variable
    Code: uint32_t pin;

🔧 FIX SUGGESTIONS (2):
--------------------------------------------------------------------------------

[1] gpio.c:15
    Error: 'GPIO_BASE' undeclared
    Suggested Fix:
    #define GPIO_BASE 0x40010000
    static volatile uint32_t *GPIO_DIR = (uint32_t*)(GPIO_BASE + 0x00);

================================================================================
Summary: 2 errors, 1 warnings
================================================================================
```

### API Integration

#### Enable traceback in upload endpoint

Add `traceback=true` query parameter:

```bash
curl -X POST "http://localhost:5000/upload?traceback=true&format=json" \
  -F "datasheet=@datasheet.pdf"
```

The response will include traceback results in the `meta.traceback` field:

```json
{
  "files": [...],
  "meta": {
    "traceback": {
      "errors": [...],
      "warnings": [...],
      "fixes": [...],
      "summary": {
        "totalErrors": 2,
        "totalWarnings": 1
      }
    }
  }
}
```

#### Dedicated traceback endpoint

```bash
# Analyze a code directory
curl -X POST http://localhost:5000/traceback \
  -H "Content-Type: application/json" \
  -d '{
    "codeDir": "/path/to/code",
    "options": {
      "useCompiler": true,
      "useStaticAnalysis": true,
      "useAI": true,
      "autoFix": false,
      "aiModel": "codellama:7b"
    }
  }'
```

### Automatic Fix Application

To automatically apply fixes:

```bash
# CLI
node backend/traceback-cli.js <code-directory> --fix

# API
curl -X POST http://localhost:5000/traceback \
  -H "Content-Type: application/json" \
  -d '{
    "codeDir": "/path/to/code",
    "options": {
      "autoFix": true,
      "useAI": true
    }
  }'
```

### Prerequisites

For full functionality, install optional tools:

```bash
# GCC compiler (for compilation checks)
# Windows: Install MinGW or use WSL
# Linux: sudo apt-get install gcc
# Mac: xcode-select --install

# cppcheck (for static analysis)
# Windows: choco install cppcheck
# Linux: sudo apt-get install cppcheck
# Mac: brew install cppcheck

# clang-tidy (optional, for advanced static analysis)
# Windows: choco install llvm
# Linux: sudo apt-get install clang-tidy
# Mac: brew install llvm
```

**Note**: The traceback system works without these tools, but with reduced functionality. It will skip checks that require unavailable tools.

### Integration in Code Generation

The traceback system is automatically integrated into the code generation flow. When you upload a datasheet with `traceback=true`, it will:

1. Generate firmware code as usual
2. Run traceback analysis on generated files
3. Request AI fixes for any errors found
4. Include results in the response

### Error Types

- **syntax**: Basic syntax errors (missing semicolons, unclosed brackets)
- **compilation**: Compilation errors (undeclared variables, type mismatches)
- **static_analysis**: Issues found by static analysis tools
- **quality**: Code quality warnings (uninitialized variables, potential bugs)

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
ollama pull codellama:7b
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
