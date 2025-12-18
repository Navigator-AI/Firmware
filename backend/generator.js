const fs = require('fs');
const path = require('path');

/**
 * generateFromSpec(parsedSpec, outDir)
 * parsedSpec is expected to have a shape like:
 * {
 *   name: "my_ip",
 *   registers: [
 *     { name: "CTRL", offset: "0x00", fields: [{name:"EN", bit:0, width:1}, ...] },
 *     ...
 *   ],
 *   peripherals: {
 *     gpio: { pins: 16 },
 *     uart: { instances: [ {name:"UART0", baud:115200} ] },
 *     spi: { instances: [...] },
 *     i2c: { instances: [...] }
 *   }
 * }
 *
 * This generator is intentionally simple — it produces readable skeletal C drivers.
 */

function safeFile(pathStr, content){
  fs.writeFileSync(pathStr, content, 'utf8');
}
// Lightweight datasheet reasoning based on free text
function analyzeDatasheet(text){
  const t = String(text||'');
  const lower = t.toLowerCase();
  const peripheral = /i2c|sda|scl/i.test(t) ? 'i2c'
                    : /spi|mosi|miso/i.test(t) ? 'spi'
                    : /uart|serial|tx\b|rx\b/i.test(t) ? 'uart'
                    : /pwm|duty|frequency/i.test(t) ? 'pwm'
                    : /adc|analog/i.test(t) ? 'adc'
                    : /gpio|button|led/i.test(t) ? 'gpio'
                    : null;
  const role = {
    master: /\bmaster\b/i.test(t),
    slave: /\bslave\b/i.test(t) || /sensor/i.test(t),
    tx: /\btransmit|\btx\b/i.test(t),
    rx: /\breceive|\brx\b/i.test(t)
  };
  const pins = {
    tx: (()=>{ const m = lower.match(/\btxd?\b[^0-9a-z]{0,12}(?:gpio\s*)?(\d{1,3})/i); return m?parseInt(m[1],10):undefined; })(),
    rx: (()=>{ const m = lower.match(/\brxd?\b[^0-9a-z]{0,12}(?:gpio\s*)?(\d{1,3})/i); return m?parseInt(m[1],10):undefined; })(),
    sda: (()=>{ const m = lower.match(/\bsda\b[^0-9a-z]{0,8}(\d{1,3})/i); return m?parseInt(m[1],10):undefined; })(),
    scl: (()=>{ const m = lower.match(/\bscl\b[^0-9a-z]{0,8}(\d{1,3})/i); return m?parseInt(m[1],10):undefined; })(),
  };
  const parameters = {
    baud: (()=>{ const m = lower.match(/\bbaud(?:\s*rate)?\b[^0-9]{0,10}(\d{4,7})/i) || lower.match(/(\d{4,7})\s*(?:bps|baud)\b/i); return m?parseInt(m[1],10):undefined; })(),
    address: (()=>{ const m = lower.match(/\baddress\b[^0-9a-fx]{0,8}(0x[0-9a-f]{2,})/i); return m?m[1]:undefined; })(),
    frequency: (()=>{ const m = lower.match(/\b(\d{2,6})\s*hz\b/i); return m?parseInt(m[1],10):undefined; })(),
  };
  const behavior = {
    framing: /start\s*byte|end\s*byte|framing|data\s*frame|\b0x7e\b|\b0x7f\b/i.test(t),
    reliability: /ack|nack|checksum|crc/i.test(t),
    loopback: /loopback|basic\s*uart\s*transfer/i.test(t)
  };
  return { peripheral, role, pins, parameters, behavior };
}


function genHeaderGuard(name){
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_H';
}

function getHex(value, fallback){
  if(typeof value === 'number') return '0x' + value.toString(16);
  if(typeof value === 'string') return value;
  return fallback;
}

function findOffset(registers, candidates, defaultOffset){
  if(!Array.isArray(registers)) return defaultOffset;
  const lowered = candidates.map(c => c.toLowerCase());
  for(const r of registers){
    const name = (r.name||'').toLowerCase();
    if(lowered.some(c => name.includes(c))){
      return r.offset || defaultOffset;
    }
  }
  return defaultOffset;
}

function emitRegisterDefines(periphKey, periph, outDir){
  if(!periph) return [];
  const regs = (periph.regs && Array.isArray(periph.regs)) ? periph.regs : [];
  const base = getHex(periph.base, periph.base ? periph.base : `0x40000000`);
  if(regs.length === 0) return [];
  const hname = `${periphKey}_regs.h`;
  const hpath = path.join(outDir, hname);
  let h = `#ifndef ${genHeaderGuard(periphKey + '_regs')}
#define ${genHeaderGuard(periphKey + '_regs')}

#include <stdint.h>

#define ${periphKey.toUpperCase()}_BASE (${base})

`;
  regs.forEach(r => {
    const nm = (r.name||'REG').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
    const off = r.offset || '0x00';
    const reset = r.reset ? String(r.reset) : null;
    const access = r.access ? String(r.access) : null;
    h += `// ${nm}\n`;
    if(reset || access){
      h += `// Reset: ${reset||'n/a'}, Access: ${access||'n/a'}\n`;
    }
    if(Array.isArray(r.fields)){
      r.fields.forEach(f => {
        const fn = (f.name||'FIELD').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
        const bit = typeof f.bit === 'number' ? f.bit : parseInt(f.bit||'0',10);
        const fdesc = (f.desc||'').replace(/\r?\n/g,' ');
        if(fdesc) h += `// Bit ${bit}: ${fn} - ${fdesc}\n`;
      });
    }
    h += `#define ${nm} (*((volatile uint32_t*)(${periphKey.toUpperCase()}_BASE + ${off})))\n`;
    if(Array.isArray(r.fields)){
      r.fields.forEach(f => {
        const fn = (f.name||'FIELD').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
        const bit = typeof f.bit === 'number' ? f.bit : parseInt(f.bit||'0',10);
        h += `#define ${nm}_${fn} (1U << ${bit})\n`;
      });
    }
    h += `\n`;
  });
  h += `
#endif
`;
  safeFile(hpath, h);
  return [hname];
}

function generateGPIO(periph, outDir, spec){
  const hname = 'gpio.h';
  const cname = 'gpio.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const pins = (periph && periph.pins) || 32;
  const h = `#ifndef ${genHeaderGuard('gpio')}
#define ${genHeaderGuard('gpio')}

#include <stdint.h>

void gpio_init(void);
void gpio_set_dir(uint32_t pin, uint8_t out);
void gpio_write(uint32_t pin, uint8_t value);
uint8_t gpio_read(uint32_t pin);

#endif
`;
  const base = getHex(periph && periph.base, '0x40010000');
  const regs = (periph && periph.regs) || (spec && spec.registers) || [];
  const dirOff = findOffset(regs, ['gpio_dir','dir','direction'], '0x00');
  const outOff = findOffset(regs, ['gpio_out','out','dataout'], '0x04');
  const inOff  = findOffset(regs, ['gpio_in','in','datain'], '0x08');
  const defs = emitRegisterDefines('gpio', { base, regs }, outDir);
  const c = `#include "gpio.h"
#include "gpio_regs.h"
/* Simple register-backed GPIO driver (skeletal) */
static volatile uint32_t *GPIO_DIR = (uint32_t*)(${base} + ${dirOff});
static volatile uint32_t *GPIO_OUT = (uint32_t*)(${base} + ${outOff});
static volatile uint32_t *GPIO_IN  = (uint32_t*)(${base} + ${inOff});

void gpio_init(void){
  /* Default: all inputs */
  *GPIO_DIR = 0x00000000;
}

void gpio_set_dir(uint32_t pin, uint8_t out){
  if(out) *GPIO_DIR |= (1u<<pin);
  else *GPIO_DIR &= ~(1u<<pin);
}

void gpio_write(uint32_t pin, uint8_t value){
  if(value) *GPIO_OUT |= (1u<<pin);
  else *GPIO_OUT &= ~(1u<<pin);
}

uint8_t gpio_read(uint32_t pin){
  return ((*GPIO_IN >> pin) & 1u);
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname, ...defs];
}

function generateMinimalArduinoCode(detectedPeripherals, outDir, spec){
  const deviceName = (spec.name || 'firmware').replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `${deviceName}.ino`;
  const filepath = path.join(outDir, filename);
  
  let content = `#include <Arduino.h>\n\n`;
  let defines = '';
  let setupContent = '  Serial.begin(115200);\n';
  let loopContent = '';
  
  // Extract pins from datasheet registers
  const regs = (spec && spec.registers) || [];
  const pinMap = {};
  
  // Parse register names and field descriptions for pin information
  for(const r of regs){
    const name = (r.name || '').toLowerCase();
    const allTexts = [name];
    if(Array.isArray(r.fields)){
      for(const f of r.fields){
        if(f && f.name) allTexts.push(String(f.name).toLowerCase());
        if(f && f.desc) allTexts.push(String(f.desc).toLowerCase());
      }
    }
    for(const t of allTexts){
      const numMatch = t.match(/(\d{1,3})/);
      const pin = numMatch ? parseInt(numMatch[1], 10) : null;
      if(pin!=null){
        if(t.includes('rx') || t.includes('uart')) pinMap.rx = pin;
        if(t.includes('tx') || t.includes('uart')) pinMap.tx = pin;
        if(t.includes('sda') || t.includes('i2c')) pinMap.sda = pin;
        if(t.includes('scl') || t.includes('i2c')) pinMap.scl = pin;
        if(t.includes('sck') || t.includes('spi')) pinMap.sck = pin;
        if(t.includes('mosi') || t.includes('spi')) pinMap.mosi = pin;
        if(t.includes('miso') || t.includes('spi')) pinMap.miso = pin;
        if(t.includes('cs') || t.includes('ss') || t.includes('chipselect')) pinMap.cs = pin;
        if(t.includes('gpio') || t.includes('led')) pinMap.gpio = pin;
        if(t.includes('adc') || t.includes('analog')) pinMap.adc = pin;
        if(t.includes('pwm')) pinMap.pwm = pin;
      }
    }
  }
  
  // Determine MAIN peripheral using analyzed context if available, else fallback
  const ctx = spec && spec._context ? spec._context : analyzeDatasheet(spec && spec._text);
  let mainPeripheral = (ctx && ctx.peripheral) ? ctx.peripheral.toLowerCase() : null;
  if(!mainPeripheral){
    const peripheralPriority = ['uart', 'i2c', 'spi', 'gpio', 'adc', 'pwm'];
    for(const p of peripheralPriority){ if(detectedPeripherals[p]){ mainPeripheral = p; break; } }
  }
  
  // Generate code for MAIN peripheral only
  if(mainPeripheral === 'uart'){
    // Always use 115200 and Serial2
    const uartPins = (detectedPeripherals.uart && detectedPeripherals.uart.pins) || (ctx && ctx.pins) || {};
    const rxPin = (typeof uartPins.rx === 'number' ? uartPins.rx : null) || pinMap.rx || 16;
    const txPin = (typeof uartPins.tx === 'number' ? uartPins.tx : null) || pinMap.tx || 17;
    const rawText = String(spec && spec._text ? spec._text : '').toLowerCase();
    const regText = regs.map(r => [r.name, ...(r.fields||[]).map(f=>`${f.name} ${f.desc||''}`)].join(' ')).join(' ').toLowerCase();
    const textBlob = rawText + ' ' + regText;

    const mentions = (k)=> textBlob.includes(k);
    const hasLoopback = mentions('loopback') || mentions('basic uart transfer');
    // Require explicit framing plus reliability keywords to emit TX/RX pair
    const hasFraming = (ctx && ctx.behavior && ctx.behavior.framing) || mentions('start byte') || mentions('end byte') || mentions('framing') || mentions('data frame') || mentions('0x7e') || mentions('0x7f');
    const hasReliability = (ctx && ctx.behavior && ctx.behavior.reliability) || mentions('ack') || mentions('nack') || mentions('checksum') || mentions('crc');
    const roles = ctx && ctx.role ? ctx.role : { master:false, slave:false, tx:false, rx:false };

    // Define pins once
    const pinDefs = `#define RXD ${rxPin}\n#define TXD ${txPin}\n`;

    if(hasFraming && hasReliability){
      // Generate transmitter and receiver sketches
      const txName = `${deviceName}_uart_tx.ino`;
      const rxName = `${deviceName}_uart_rx.ino`;
      const txPath = path.join(outDir, txName);
      const rxPath = path.join(outDir, rxName);

      const txCode = `#include <Arduino.h>\n\n${pinDefs}\n#define BAUD 115200\n#define START_BYTE 0x7E\n#define END_BYTE 0x7F\n#define ACK 0x06\n#define NACK 0x15\n\nuint8_t computeChecksum(const uint8_t *buf, size_t len){ uint8_t c=0; for(size_t i=0;i<len;i++){ c^=buf[i]; } return c; }\n\nvoid setup(){\n  Serial.begin(115200);\n  Serial2.begin(BAUD, SERIAL_8N1, RXD, TXD);\n  Serial.println("UART TX ready. Type lines to send.");\n}\n\nvoid loop(){\n  static String line="";\n  while(Serial.available()){\n    char ch = Serial.read();\n    if(ch=='\n' || ch=='\r'){\n      if(line.length()>0){\n        const uint8_t *data = (const uint8_t*)line.c_str();\n        uint8_t cs = computeChecksum(data, line.length());\n        Serial2.write(START_BYTE);\n        Serial2.write(data, line.length());\n        Serial2.write(cs);\n        Serial2.write(END_BYTE);\n        unsigned long t0 = millis();\n        int resp=-1;\n        while(millis()-t0 < 500){ if(Serial2.available()){ resp = Serial2.read(); break; } }\n        if(resp==ACK) Serial.println("ACK"); else if(resp==NACK) Serial.println("NACK"); else Serial.println("No response");\n        line = "";\n      }\n    } else { line += ch; }\n  }\n}`;

      const rxCode = `#include <Arduino.h>\n\n${pinDefs}\n#define BAUD 115200\n#define START_BYTE 0x7E\n#define END_BYTE 0x7F\n#define ACK 0x06\n#define NACK 0x15\n\nuint8_t computeChecksum(const uint8_t *buf, size_t len){ uint8_t c=0; for(size_t i=0;i<len;i++){ c^=buf[i]; } return c; }\n\nvoid setup(){\n  Serial.begin(115200);\n  Serial2.begin(BAUD, SERIAL_8N1, RXD, TXD);\n  Serial.println("UART RX ready.");\n}\n\nvoid loop(){\n  static bool inFrame=false;\n  static uint8_t buf[256];\n  static size_t len=0;\n  while(Serial2.available()){\n    uint8_t b = Serial2.read();\n    if(!inFrame){ if(b==START_BYTE){ inFrame=true; len=0; } }\n    else {\n      if(b==END_BYTE){\n        if(len==0){ Serial2.write(NACK); inFrame=false; continue; }\n        if(len<1){ Serial2.write(NACK); inFrame=false; continue; }\n        uint8_t cs = buf[len-1];\n        uint8_t calc = computeChecksum(buf, len-1);\n        if(cs==calc){\n          Serial.print("DATA: ");\n          for(size_t i=0;i<len-1;i++){ Serial.write(buf[i]); }\n          Serial.println();\n          Serial2.write(ACK);\n        } else { Serial2.write(NACK); }\n        inFrame=false; len=0;\n      } else { if(len<sizeof(buf)) buf[len++]=b; }\n    }\n  }\n}`;

      safeFile(txPath, txCode);
      safeFile(rxPath, rxCode);
      return [txName, rxName];
    } else if((roles.master && roles.slave) && !(hasFraming && hasReliability)){
      // Generate master and slave sketches when roles are explicit and framed mode not enforced
      const mName = `${deviceName}_uart_master.ino`;
      const sName = `${deviceName}_uart_slave.ino`;
      const mPath = path.join(outDir, mName);
      const sPath = path.join(outDir, sName);

      const pinDefs = `#define RXD ${rxPin}\n#define TXD ${txPin}\n`;
      const masterCode = `#include <Arduino.h>\n\n${pinDefs}\n#define BAUD 115200\n#define ACK 0x06\n#define NACK 0x15\n\nconst char *REQUEST_CMD = "REQ:TEMP";\n\nvoid setup(){\n  Serial.begin(115200);\n  Serial2.begin(BAUD, SERIAL_8N1, RXD, TXD);\n  Serial.println("UART Master ready.");\n}\n\nvoid flushInput(Stream &s){\n  while(s.available()){ s.read(); }\n}\n\nString readLine(Stream &s, unsigned long timeoutMs){\n  String out="";\n  unsigned long t0=millis();\n  while(millis()-t0 < timeoutMs){\n    if(s.available()){\n      char ch = s.read();\n      if(ch=='\\r' || ch=='\\n'){\n        if(ch=='\\r' && s.peek()=='\\n'){ s.read(); }\n        break;\n      }\n      out+=ch;\n    }\n  }\n  return out;\n}\n\nbool waitForAck(Stream &s, uint8_t &resp, unsigned long timeoutMs){\n  unsigned long t0=millis();\n  while(millis()-t0 < timeoutMs){\n    if(s.available()){\n      resp = s.read();\n      if(resp==ACK || resp==NACK){ return true; }\n    }\n  }\n  return false;\n}\n\nvoid loop(){\n  flushInput(Serial2);\n  Serial2.print(REQUEST_CMD);\n  Serial2.print('\\n');\n  Serial2.flush();\n\n  uint8_t resp=0;\n  if(waitForAck(Serial2, resp, 500) && resp==ACK){\n    String line = readLine(Serial2, 1000);\n    if(line.startsWith("DATA:")){\n      Serial.println(line);\n    } else if(line.length()==0){\n      Serial.println("Timeout waiting DATA");\n    } else {\n      Serial.println("Invalid DATA");\n    }\n  } else if(resp==NACK){\n    Serial.println("Received NACK");\n  } else {\n    Serial.println("Timeout/No ACK");\n  }\n  delay(1000);\n}`;

      const slaveCode = `#include <Arduino.h>\n\n${pinDefs}\n#define BAUD 115200\n#define ACK 0x06\n#define NACK 0x15\nfloat readTemp(){ static int c=0; c=(c+1)%50; return 20.0 + c*0.1; }\n\nvoid setup(){\n  Serial.begin(115200);\n  Serial2.begin(BAUD, SERIAL_8N1, RXD, TXD);\n  Serial.println("UART Slave ready.");\n}\n\nString readLine(Stream &s, unsigned long timeoutMs){\n  String out="";\n  unsigned long t0=millis();\n  while(millis()-t0 < timeoutMs){\n    if(s.available()){\n      char ch = s.read();\n      if(ch=='\\r' || ch=='\\n'){\n        if(ch=='\\r' && s.peek()=='\\n'){ s.read(); }\n        break;\n      }\n      out+=ch;\n    }\n  }\n  return out;\n}\n\nvoid loop(){\n  if(!Serial2.available()){\n    delay(5);\n    return;\n  }\n  String req = readLine(Serial2, 500);\n  if(req.length()==0){\n    return;\n  }\n  if(req.startsWith("REQ:TEMP")){\n    Serial2.write(ACK);\n    Serial2.flush();\n    float t = readTemp();\n    Serial2.print("DATA:TEMP:");\n    Serial2.println(t,1);\n    Serial2.flush();\n  } else {\n    Serial2.write(NACK);\n    Serial2.flush();\n  }\n}`;

      safeFile(mPath, masterCode);
      safeFile(sPath, slaveCode);
      return [mName, sName];
    } else {
      // Default loopback/buffered test
      defines += `${pinDefs}\nString receivedData = "";\n\n`;
      setupContent += `  Serial2.begin(115200, SERIAL_8N1, RXD, TXD);\n  Serial.println("ESP32 UART Communication Started");\n  Serial.println("Type something and press Enter...");\n`;
      loopContent += `  while(Serial.available()){ Serial2.write(Serial.read()); }\n  while(Serial2.available()){\n    char c = Serial2.read();\n    if(c == '\\n' || c == '\\r'){\n      if(receivedData.length() > 0){\n        Serial.print("Received: ");\n        Serial.println(receivedData);\n        receivedData = "";\n      }\n    }else{\n      receivedData += c;\n    }\n  }\n`;
    }
  }
  
  else if(mainPeripheral === 'i2c'){
    const sdaPin = pinMap.sda || 21;
    const sclPin = pinMap.scl || 22;
    
    content += `#include <Wire.h>\n\n`;
    defines += `#define SDA_PIN ${sdaPin}\n#define SCL_PIN ${sclPin}\n#define I2C_ADDR 0x48\n\n`;
    setupContent += `  Wire.begin(SDA_PIN, SCL_PIN);\n`;
    loopContent += `  Wire.beginTransmission(I2C_ADDR);\n  Wire.write(0x00);\n  Wire.endTransmission();\n  Wire.requestFrom(I2C_ADDR, 2);\n  if(Wire.available() >= 2){\n    uint16_t data = (Wire.read() << 8) | Wire.read();\n    Serial.println(data);\n  }\n  delay(1000);\n`;
  }
  
  else if(mainPeripheral === 'spi'){
    const sck = pinMap.sck || 18;
    const mosi = pinMap.mosi || 23;
    const miso = pinMap.miso || 19;
    const cs = pinMap.cs || 5;
    
    // Look for SPI read commands in registers
    let readCommand = 0x9F; // Default JEDEC ID command
    let readBytes = 3; // Default 3 bytes for JEDEC ID
    
    for(const r of regs){
      const name = (r.name || '').toLowerCase();
      const fields = r.fields || [];
      
      // Look for read commands in register fields
      for(const f of fields){
        const fieldName = (f.name || '').toLowerCase();
        const fieldDesc = (f.desc || '').toLowerCase();
        
        // Check for common SPI read commands
        if(fieldName.includes('read') || fieldName.includes('jedec') || fieldName.includes('id')){
          if(fieldDesc.includes('0x9f') || fieldDesc.includes('jedec')){
            readCommand = 0x9F;
            readBytes = 3;
          } else if(fieldDesc.includes('0x90')){
            readCommand = 0x90;
            readBytes = 2;
          } else if(fieldDesc.includes('0x03')){
            readCommand = 0x03;
            readBytes = 1;
          }
        }
        
        // Look for command bytes in field descriptions
        const cmdMatch = fieldDesc.match(/0x([0-9a-f]{2})/i);
        if(cmdMatch){
          readCommand = parseInt(cmdMatch[1], 16);
          // Determine bytes based on command
          if(readCommand === 0x9F) readBytes = 3;
          else if(readCommand === 0x90) readBytes = 2;
          else readBytes = 1;
        }
      }
    }
    
    content += `#include <SPI.h>\n\n`;
    defines += `#define SCK ${sck}\n#define MOSI ${mosi}\n#define MISO ${miso}\n#define CS ${cs}\n\n`;
    setupContent += `  SPI.begin(SCK, MISO, MOSI, CS);\n  pinMode(CS, OUTPUT);\n  digitalWrite(CS, HIGH);\n`;
    
    if(readBytes === 1){
      loopContent += `  digitalWrite(CS, LOW);\n  SPI.transfer(0x${readCommand.toString(16).toUpperCase()});\n  uint8_t data = SPI.transfer(0x00);\n  digitalWrite(CS, HIGH);\n  Serial.print("SPI Read: 0x");\n  Serial.println(data, HEX);\n  delay(1000);\n`;
    } else if(readBytes === 2){
      loopContent += `  digitalWrite(CS, LOW);\n  SPI.transfer(0x${readCommand.toString(16).toUpperCase()});\n  uint16_t data = (SPI.transfer(0x00) << 8) | SPI.transfer(0x00);\n  digitalWrite(CS, HIGH);\n  Serial.print("SPI Read: 0x");\n  Serial.println(data, HEX);\n  delay(1000);\n`;
    } else {
      loopContent += `  digitalWrite(CS, LOW);\n  SPI.transfer(0x${readCommand.toString(16).toUpperCase()});\n  uint8_t b1 = SPI.transfer(0x00);\n  uint8_t b2 = SPI.transfer(0x00);\n  uint8_t b3 = SPI.transfer(0x00);\n  digitalWrite(CS, HIGH);\n  Serial.print("SPI Read: 0x");\n  Serial.print(b1, HEX);\n  Serial.print(" ");\n  Serial.print(b2, HEX);\n  Serial.print(" ");\n  Serial.println(b3, HEX);\n  delay(1000);\n`;
    }
  }
  
  else if(mainPeripheral === 'gpio'){
    const gpioPin = pinMap.gpio || 2;
    defines += `#define LED_PIN ${gpioPin}\n\n`;
    setupContent += `  pinMode(LED_PIN, OUTPUT);\n`;
    loopContent += `  digitalWrite(LED_PIN, HIGH);\n  delay(500);\n  digitalWrite(LED_PIN, LOW);\n  delay(500);\n`;
  }
  
  else if(mainPeripheral === 'adc'){
    const adcPin = pinMap.adc || 36;
    defines += `#define ADC_PIN ${adcPin}\n\n`;
    setupContent += `  pinMode(ADC_PIN, ANALOG);\n`;
    loopContent += `  Serial.println(analogRead(ADC_PIN));\n  delay(1000);\n`;
  }
  
  else if(mainPeripheral === 'pwm'){
    const pwmPin = pinMap.pwm || 2;
    defines += `#define PWM_PIN ${pwmPin}\n\n`;
    setupContent += `  ledcSetup(0, 1000, 8);\n  ledcAttachPin(PWM_PIN, 0);\n`;
    loopContent += `  ledcWrite(0, 128);\n  delay(1000);\n`;
  }
  
  // If no peripherals detected, ask for pin confirmation
  else {
    content = `#include <Arduino.h>

#define LED_PIN 2

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(500);
  digitalWrite(LED_PIN, LOW);
  delay(500);
}`;
    safeFile(filepath, content);
    return [filename];
  }
  
  content += defines;
  content += `void setup() {\n${setupContent}\n}\n\nvoid loop() {\n${loopContent}\n}`;
  
  safeFile(filepath, content);
  return [filename];
}

function generateUART(periph, outDir, spec){
  const hname = 'uart.h';
  const cname = 'uart.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const inst = (periph && periph.instances) || [{name:'UART0', baud:115200}];
  const h = `#ifndef ${genHeaderGuard('uart')}
#define ${genHeaderGuard('uart')}

#include <stdint.h>

void uart_init(int baud);
void uart_send_byte(uint8_t b);
uint8_t uart_recv_byte(void);

#endif
`;
  const base = getHex(periph && periph.base, '0x40020000');
  const regs = (periph && periph.regs) || (spec && spec.registers) || [];
  const dataOff = findOffset(regs, ['uart_data','txrx','thr','rbr','data'], '0x00');
  const statOff = findOffset(regs, ['uart_status','lsr','status'], '0x04');
  const defs = emitRegisterDefines('uart', { base, regs }, outDir);
  const c = `#include "uart.h"
#include "uart_regs.h"
/* Simple polling UART driver (skeletal) */
static volatile uint32_t *UART_DATA = (uint32_t*)(${base} + ${dataOff});
static volatile uint32_t *UART_STATUS = (uint32_t*)(${base} + ${statOff});

void uart_init(int baud){
  /* configure baud -> placeholder */
  (void)baud;
}
void uart_send_byte(uint8_t b){
  while((*UART_STATUS & 0x1)==0); // wait tx ready
  *UART_DATA = b;
}
uint8_t uart_recv_byte(void){
  while((*UART_STATUS & 0x2)==0); // wait rx ready
  return (uint8_t)(*UART_DATA & 0xFF);
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname, ...defs];
}

function findExact(registers, exactNames){
  if(!Array.isArray(registers)) return null;
  const lowered = exactNames.map(n => n.toLowerCase());
  for(const r of registers){
    const name = (r.name||'').toLowerCase();
    if(lowered.includes(name)) return r.offset || null;
  }
  return null;
}

function generateSPI(periph, outDir, spec){
  const hname = 'spi.h';
  const cname = 'spi.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef ${genHeaderGuard('spi')}
#define ${genHeaderGuard('spi')}

#include <stdint.h>

void spi_init(void);
// Back-compat for previously generated examples
static inline void spi_init_master(void){ spi_init(); }
uint8_t spi_transfer(uint8_t out);

#endif
`;
  const base = getHex(periph && periph.base, '0x40030000');
  const regs = (periph && periph.regs) || (spec && spec.registers) || [];
  // Prefer exact TI-style names if present
  const offSPIDAT1 = findExact(regs, ['SPIDAT1']) || findOffset(regs, ['spidat1','spidat','spi_data','txrx','dr','data'], '0x00');
  const offSPIBUF  = findExact(regs, ['SPIBUF'])  || findOffset(regs, ['spibuf','spi_buf','status','sr'], '0x04');
  const offSPIGCR0 = findExact(regs, ['SPIGCR0']) || findOffset(regs, ['spigcr0','ctrl0','control0','gcr0'], '0x00');
  const offSPIGCR1 = findExact(regs, ['SPIGCR1']) || findOffset(regs, ['spigcr1','ctrl1','control1','gcr1'], '0x04');
  const offSPIFMT0 = findExact(regs, ['SPIFMT0']) || findOffset(regs, ['spifmt0','fmt0','format0'], '0x10');
  const defs = emitRegisterDefines('spi', { base, regs }, outDir);
  const c = `#include "spi.h"
#include "spi_regs.h"
/* Simple SPI master (full duplex) skeletal */
// Register map derived from parsed spec (fallbacks used if missing)
static volatile uint32_t *SPIGCR0 = (uint32_t*)(${base} + ${offSPIGCR0});
static volatile uint32_t *SPIGCR1 = (uint32_t*)(${base} + ${offSPIGCR1});
static volatile uint32_t *SPIFMT0 = (uint32_t*)(${base} + ${offSPIFMT0});
static volatile uint32_t *SPIDAT1 = (uint32_t*)(${base} + ${offSPIDAT1});
static volatile uint32_t *SPIBUF  = (uint32_t*)(${base} + ${offSPIBUF});

void spi_init(void){
  /* minimal master config; adjust per SoC */
  *SPIGCR0 = 0x00000000; // reset
  *SPIGCR1 = 0x00000001; // enable module
  *SPIFMT0 = 0x00000000; // default format
}
uint8_t spi_transfer(uint8_t out){
  *SPIDAT1 = out;
  // wait until data available in buffer; common SoCs set flags in SPIBUF upper bits
  while(((*SPIBUF) & 0x00010000u)==0u) { /* wait RX ready */ }
  return (uint8_t)((*SPIBUF) & 0xFF);
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname, ...defs];
}

function generateI2C(periph, outDir, spec){
  const hname = 'i2c.h';
  const cname = 'i2c.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef ${genHeaderGuard('i2c')}
#define ${genHeaderGuard('i2c')}

#include <stdint.h>

void i2c_init(void);
int i2c_write(uint8_t addr, const uint8_t *buf, uint32_t len);
int i2c_read(uint8_t addr, uint8_t *buf, uint32_t len);

#endif
`;
  const base = getHex(periph && periph.base, '0x40040000');
  const regs = (periph && periph.regs) || (spec && spec.registers) || [];
  const ctrlOff = findOffset(regs, ['i2c_ctrl','control','cr'], '0x00');
  const dataOff = findOffset(regs, ['i2c_data','txrx','dr','data'], '0x04');
  const defs = emitRegisterDefines('i2c', { base, regs }, outDir);
  const c = `#include "i2c.h"
#include "i2c_regs.h"
/* Simple I2C master skeletal */
static volatile uint32_t *I2C_CTRL = (uint32_t*)(${base} + ${ctrlOff});
static volatile uint32_t *I2C_DATA = (uint32_t*)(${base} + ${dataOff});

void i2c_init(void){
  /* configure */
}
int i2c_write(uint8_t addr, const uint8_t *buf, uint32_t len){
  (void)addr; (void)buf; (void)len;
  return 0; // 0 = success
}
int i2c_read(uint8_t addr, uint8_t *buf, uint32_t len){
  (void)addr; (void)buf; (void)len;
  return 0;
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname, ...defs];
}

function generateADC(periph, outDir, spec){
  const hname = 'adc.h';
  const cname = 'adc.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef ${genHeaderGuard('adc')}
#define ${genHeaderGuard('adc')}

#include <stdint.h>

void adc_init(void);
uint16_t adc_read(uint8_t channel);

#endif
`;
  const base = getHex(periph && periph.base, '0x40050000');
  const regs = (spec && spec.registers) || [];
  const ctrlOff = findOffset(regs, ['adc_ctrl','control','cr'], '0x00');
  const chselOff = findOffset(regs, ['adc_ch','channel','chsel'], '0x04');
  const startOff = findOffset(regs, ['adc_start','start','swtrig'], '0x08');
  const statOff = findOffset(regs, ['adc_stat','status','sr'], '0x0C');
  const dataOff = findOffset(regs, ['adc_data','data','dr'], '0x10');
  const c = `#include "adc.h"
/* Simple polling ADC skeletal */
static volatile uint32_t *ADC_CTRL  = (uint32_t*)(${base} + ${ctrlOff});
static volatile uint32_t *ADC_CHSEL = (uint32_t*)(${base} + ${chselOff});
static volatile uint32_t *ADC_START = (uint32_t*)(${base} + ${startOff});
static volatile uint32_t *ADC_STAT  = (uint32_t*)(${base} + ${statOff});
static volatile uint32_t *ADC_DATA  = (uint32_t*)(${base} + ${dataOff});

void adc_init(void){
  *ADC_CTRL = 0x00000001; // enable
}

uint16_t adc_read(uint8_t channel){
  *ADC_CHSEL = (uint32_t)(channel & 0xFF);
  *ADC_START = 1u; // start conversion
  while(((*ADC_STAT) & 0x1u) == 0u) { /* wait EOC */ }
  return (uint16_t)(*ADC_DATA & 0x0FFF);
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateTimers(outDir){
  const hname = 'timer.h';
  const cname = 'timer.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef ${genHeaderGuard('timer')}
#define ${genHeaderGuard('timer')}

#include <stdint.h>

void timer_init(void);
void timer_start(void);
void timer_delay_ms(uint32_t ms);

#endif
`;
  const c = `#include "timer.h"
#include "platform.h"

void timer_init(void){
  /* Replace with hardware timer init */
}

void timer_start(void){
  /* Replace with starting a hardware timer */
}

void timer_delay_ms(uint32_t ms){
  while(ms--){
    delay_us(1000);
  }
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateInterruptStubs(outDir){
  const hname = 'interrupts.h';
  const cname = 'interrupts.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef INTERRUPTS_H
#define INTERRUPTS_H

#include <stdint.h>

// Weakly-linked ISR prototypes (override in your application)
void gpio_isr(void);
void timer_isr(void);
void gpio_isr_handler(void);

#endif
`;
  const c = `#include "interrupts.h"

__attribute__((weak)) void gpio_isr(void){
  // GPIO interrupt handler stub
}

__attribute__((weak)) void timer_isr(void){
  // Timer interrupt handler stub
}

// Additional weak handler that user code can override and call from gpio_isr
__attribute__((weak)) void gpio_isr_handler(void){
  // User can override in application to handle button/LED toggle
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateDebug(outDir){
  const hname = 'debug.h';
  const cname = 'debug.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef DEBUG_H
#define DEBUG_H

#include <stdint.h>
#include "uart.h"

void uart_send_string(const char *s);
void uart_send_hex8(uint8_t v);
void uart_send_hex16(uint16_t v);
void uart_send_uint(uint32_t v);

#define DBG_PRINT(msg) uart_send_string(msg)

#endif
`;
  const c = `#include "debug.h"

void uart_send_string(const char *s){
  if(!s) return;
  for(const char *p = s; *p; ++p){
    uart_send_byte((uint8_t)*p);
  }
}

static const char HEX_CHARS[16] = {
  '0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'
};

void uart_send_hex8(uint8_t v){
  uart_send_byte((uint8_t)HEX_CHARS[(v>>4)&0xF]);
  uart_send_byte((uint8_t)HEX_CHARS[v&0xF]);
}
void uart_send_hex16(uint16_t v){
  uart_send_hex8((uint8_t)(v>>8));
  uart_send_hex8((uint8_t)(v&0xFF));
}
void uart_send_uint(uint32_t v){
  char buf[11];
  int i = 0;
  if(v == 0){ uart_send_byte('0'); return; }
  while(v && i < (int)sizeof(buf)){
    uint32_t q = v / 10u;
    uint32_t r = v - q*10u;
    buf[i++] = (char)('0' + r);
    v = q;
  }
  while(i-- > 0){ uart_send_byte((uint8_t)buf[i]); }
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateMain(outDir, opts){
  const cname = 'main.c';
  const cpath = path.join(outDir, cname);
  const demo = (opts && opts.demo) || '';
  const wantBlink = demo === 'led_blink' || demo === '';
  const wantEcho = demo === 'uart_echo' || demo === '';
  const wantAdc  = demo === 'adc_read'  || demo === 'adc_debug' || demo === '';
  const wantSpi  = demo === 'spi_byte';
  const wantI2c  = demo === 'i2c_temp';
  const wantSM   = demo === 'state_machine';
  const wantPWM  = demo === 'pwm_control';
  const wantGPIOInt = demo === 'gpio_interrupt';
  const wantStruct  = demo === 'struct_demo';
  const wantBitops  = demo === 'bitops_demo';
  const c = `#include <stdint.h>
#include "board.h"
#include "platform.h"
#include "timer.h"
#include "gpio.h"
#include "uart.h"
#include "adc.h"
#include "debug.h"
#include "spi.h"
#include "i2c.h"
#include "interrupts.h"
#include "constants.h"
#include "bitops.h"

typedef struct {
  uint8_t pin;
  uint8_t direction; // 0=input, 1=output
} gpio_config_t;

static void blink_demo(void){
  gpio_init();
  gpio_set_dir(LED_PIN, 1);
  while(1){
    gpio_write(LED_PIN, 1);
    timer_delay_ms(LED_DELAY_MS);
    gpio_write(LED_PIN, 0);
    timer_delay_ms(LED_DELAY_MS);
    break; // run once in demo
  }
}

static void button_toggle_demo(void){
  gpio_set_dir(BUTTON_PIN, 0);
  gpio_set_dir(LED_PIN, 1);
  uint8_t last = gpio_read(BUTTON_PIN);
  for(int i=0;i<50;i++){
    uint8_t now = gpio_read(BUTTON_PIN);
    if(now && !last){
      uint8_t v = gpio_read(LED_PIN);
      gpio_write(LED_PIN, !v);
    }
    last = now;
    timer_delay_ms(20);
  }
}

static void uart_echo_demo(void){
  uart_init(115200);
  DBG_PRINT("UART echo demo\n");
  // echo 8 bytes then return
  for(int i=0;i<8;i++){
    uint8_t b = uart_recv_byte();
    uart_send_byte(b);
  }
}

static void adc_print_demo(void){
  adc_init();
  DBG_PRINT("ADC read demo\n");
  // simple binary print over UART of channel 0 value (twice)
  for(int i=0;i<2;i++){
    uint16_t v = adc_read(0);
    uart_send_byte((uint8_t)(v >> 8));
    uart_send_byte((uint8_t)(v & 0xFF));
    timer_delay_ms(10);
  }
}

static void adc_debug_demo(void){
  adc_init();
  uart_init(115200);
  DBG_PRINT("ADC debug values: ");
  for(int i=0;i<5;i++){
    uint16_t v = adc_read(0);
    uart_send_uint((uint32_t)v);
    DBG_PRINT(i<4?", ":"\n");
    timer_delay_ms(50);
  }
}

static void spi_demo(void){
  spi_init();
  uart_init(115200);
  DBG_PRINT("SPI xfer 0xA5 -> 0x");
  uint8_t r = spi_transfer(0xA5);
  uart_send_hex8(r);
  DBG_PRINT("\n");
}

static void i2c_temp_demo(void){
  i2c_init();
  uart_init(115200);
  DBG_PRINT("I2C temp mock read: 0x");
  uint8_t buf[2] = {0,0};
  (void)i2c_read(0x48, buf, 2);
  uart_send_hex8(buf[0]);
  uart_send_hex8(buf[1]);
  DBG_PRINT("\n");
}

static void state_machine_demo(void){
  gpio_init();
  gpio_set_dir(LED_PIN,1);
  led_state_t state = LED_OFF;
  for(int i=0;i<20;i++){
    switch(state){
      case LED_OFF: gpio_write(LED_PIN,0); state = LED_ON; break;
      case LED_ON:  gpio_write(LED_PIN,1); state = LED_OFF; break;
      default: gpio_write(LED_PIN,0); state = LED_OFF; break;
    }
    timer_delay_ms(100);
  }
}

static void pwm_control_demo(void){
  gpio_init();
  gpio_set_dir(LED_PIN,1);
  // very rough software PWM demo
  for(int duty=0; duty<=100; duty+=10){
    for(int c=0;c<50;c++){
      int on_us = duty * 100; // 10ms period
      int off_us = (100-duty) * 100;
      gpio_write(LED_PIN,1); delay_us((uint32_t)on_us);
      gpio_write(LED_PIN,0); delay_us((uint32_t)off_us);
    }
  }
}

static volatile uint8_t g_led_state = 0;
void gpio_isr_handler(void){
  // toggle LED on interrupt
  g_led_state ^= 1u;
  gpio_write(LED_PIN, g_led_state);
}

static void gpio_interrupt_demo(void){
  gpio_init();
  gpio_set_dir(BUTTON_PIN, 0);
  gpio_set_dir(LED_PIN, 1);
  // In real HW you'd configure edge triggers and enable the NVIC/IRQ here.
  // This demo simply calls the handler as if an interrupt occurred.
  DBG_PRINT("GPIO interrupt demo (simulated)\n");
  for(int i=0;i<3;i++){
    gpio_isr_handler();
    timer_delay_ms(200);
  }
}

static void struct_demo(void){
  gpio_config_t cfg = { LED_PIN, 1 };
  gpio_init();
  gpio_set_dir(cfg.pin, cfg.direction);
  gpio_write(cfg.pin, 1);
  timer_delay_ms(LED_DELAY_MS);
  gpio_write(cfg.pin, 0);
}

static void bitops_demo(void){
  static volatile uint32_t fake_reg = 0;
  // use TOGGLE_BIT to simulate LED toggling
  for(int i=0;i<4;i++){
    TOGGLE_BIT(fake_reg, 0);
    uint8_t v = (uint8_t)READ_BIT(fake_reg, 0);
    gpio_write(LED_PIN, v);
    timer_delay_ms(LED_DELAY_MS/2);
  }
}

int main(void){
  timer_init();
  timer_start();
  if(${wantBlink ? '1' : '0'}){ DBG_PRINT("Blink demo\n"); blink_demo(); }
  if(${demo === '' ? '1' : '0'}){ button_toggle_demo(); }
  if(${wantEcho ? '1' : '0'}){ uart_echo_demo(); }
  if(${wantAdc && demo !== 'adc_debug' ? '1' : '0'}){ adc_print_demo(); }
  if(${demo === 'adc_debug' ? '1' : '0'}){ adc_debug_demo(); }
  if(${wantSpi ? '1' : '0'}){ spi_demo(); }
  if(${wantI2c ? '1' : '0'}){ i2c_temp_demo(); }
  if(${wantSM ? '1' : '0'}){ state_machine_demo(); }
  if(${wantPWM ? '1' : '0'}){ pwm_control_demo(); }
  if(${wantGPIOInt ? '1' : '0'}){ gpio_interrupt_demo(); }
  if(${wantStruct ? '1' : '0'}){ struct_demo(); }
  if(${wantBitops ? '1' : '0'}){ bitops_demo(); }
  while(1){}
  return 0;
}
`;
  safeFile(cpath, c);
  return [cname];
}

function generateBoardConfig(outDir){
  const hname = 'board.h';
  const hpath = path.join(outDir, hname);
  const h = `#ifndef BOARD_H
#define BOARD_H

// Default GPIO pin mapping for bit-banged buses (adjust as needed)
#define GPIO_SCL_PIN 0
#define GPIO_SDA_PIN 1
#define GPIO_SCLK_PIN 2
#define GPIO_MOSI_PIN 3
#define GPIO_MISO_PIN 4
#define GPIO_CS_PIN 5

// Application pins
#define LED_PIN 0
#define BUTTON_PIN 1

#endif
`;
  safeFile(hpath, h);
  return [hname];
}

function generateConstants(outDir){
  const hname = 'constants.h';
  const hpath = path.join(outDir, hname);
  const h = `#ifndef CONSTANTS_H
#define CONSTANTS_H

#define LED_DELAY_MS 1000

typedef enum { LED_OFF = 0, LED_ON = 1, LED_BLINK = 2 } led_state_t;

#endif
`;
  safeFile(hpath, h);
  return [hname];
}

function generateBitops(outDir){
  const hname = 'bitops.h';
  const hpath = path.join(outDir, hname);
  const h = `#ifndef BITOPS_H
#define BITOPS_H

#define SET_BIT(REG, BIT)    ((REG) |= (1U << (BIT)))
#define CLEAR_BIT(REG, BIT)  ((REG) &= ~(1U << (BIT)))
#define TOGGLE_BIT(REG, BIT) ((REG) ^= (1U << (BIT)))
#define READ_BIT(REG, BIT)   (((REG) >> (BIT)) & 1U)

#endif
`;
  safeFile(hpath, h);
  return [hname];
}

function generatePlatformDelay(outDir){
  const hname = 'platform.h';
  const cname = 'platform.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef PLATFORM_H
#define PLATFORM_H

#include <stdint.h>

void delay_us(uint32_t us);

#endif
`;
  const c = `#include "platform.h"

// Very rough busy-wait; replace with timer-based delay for your platform
void delay_us(uint32_t us){
  volatile uint32_t n = us * 60; // tune for your MCU clock
  while(n--){ __asm__ __volatile__("":::"memory"); }
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateSoftGPIO(outDir){
  const hname = 'soft_gpio.h';
  const cname = 'soft_gpio.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef SOFT_GPIO_H
#define SOFT_GPIO_H

#include <stdint.h>

void gpio_init(void);
void gpio_set_dir(uint32_t pin, uint8_t out);
void gpio_write(uint32_t pin, uint8_t value);
uint8_t gpio_read(uint32_t pin);

#endif
`;
  const c = `#include "soft_gpio.h"

// Stub GPIO for portability: replace with real hardware access
static uint8_t gpio_dir[64];
static uint8_t gpio_val[64];

void gpio_init(void){
  for(int i=0;i<64;i++){ gpio_dir[i]=0; gpio_val[i]=0; }
}
void gpio_set_dir(uint32_t pin, uint8_t out){
  if(pin<64) gpio_dir[pin] = out ? 1u : 0u;
}
void gpio_write(uint32_t pin, uint8_t value){
  if(pin<64) gpio_val[pin] = value ? 1u : 0u;
}
uint8_t gpio_read(uint32_t pin){
  return (pin<64) ? gpio_val[pin] : 0u;
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateSoftI2C(outDir){
  const hname = 'soft_i2c.h';
  const cname = 'soft_i2c.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef SOFT_I2C_H
#define SOFT_I2C_H

#include <stdint.h>

void soft_i2c_init(void);
int soft_i2c_write(uint8_t addr7, const uint8_t *buf, uint32_t len);
int soft_i2c_read(uint8_t addr7, uint8_t *buf, uint32_t len);

#endif
`;
  const c = `#include "soft_i2c.h"
#include "soft_gpio.h"
#include "platform.h"
#include "board.h"

static void scl_high(void){ gpio_write(GPIO_SCL_PIN, 1); }
static void scl_low(void){ gpio_write(GPIO_SCL_PIN, 0); }
static void sda_high(void){ gpio_write(GPIO_SDA_PIN, 1); }
static void sda_low(void){ gpio_write(GPIO_SDA_PIN, 0); }
static uint8_t sda_read(void){ return gpio_read(GPIO_SDA_PIN); }

static void i2c_delay(void){ delay_us(2); }

static void i2c_start(void){
  sda_high(); scl_high(); i2c_delay();
  sda_low(); i2c_delay();
  scl_low(); i2c_delay();
}
static void i2c_stop(void){
  sda_low(); i2c_delay();
  scl_high(); i2c_delay();
  sda_high(); i2c_delay();
}
static int i2c_write_byte(uint8_t b){
  for(int i=7;i>=0;--i){
    if(b & (1u<<i)) sda_high(); else sda_low();
    i2c_delay();
    scl_high(); i2c_delay();
    scl_low(); i2c_delay();
  }
  // ACK bit
  sda_high(); // release
  i2c_delay();
  scl_high(); i2c_delay();
  int ack = (sda_read()==0);
  scl_low(); i2c_delay();
  return ack ? 0 : -1;
}
static uint8_t i2c_read_byte(int sendAck){
  uint8_t v = 0;
  sda_high(); // release
  for(int i=7;i>=0;--i){
    scl_high(); i2c_delay();
    if(sda_read()) v |= (1u<<i);
    scl_low(); i2c_delay();
  }
  // ACK/NACK
  if(sendAck) sda_low(); else sda_high();
  i2c_delay();
  scl_high(); i2c_delay();
  scl_low(); i2c_delay();
  sda_high();
  return v;
}

void soft_i2c_init(void){
  gpio_init();
  gpio_set_dir(GPIO_SCL_PIN, 1);
  gpio_set_dir(GPIO_SDA_PIN, 1);
  scl_high(); sda_high();
}

int soft_i2c_write(uint8_t addr7, const uint8_t *buf, uint32_t len){
  i2c_start();
  if(i2c_write_byte((addr7<<1)|0x00) != 0){ i2c_stop(); return -1; }
  for(uint32_t i=0;i<len;i++){
    if(i2c_write_byte(buf[i]) != 0){ i2c_stop(); return -2; }
  }
  i2c_stop();
  return 0;
}

int soft_i2c_read(uint8_t addr7, uint8_t *buf, uint32_t len){
  i2c_start();
  if(i2c_write_byte((addr7<<1)|0x01) != 0){ i2c_stop(); return -1; }
  for(uint32_t i=0;i<len;i++){
    buf[i] = i2c_read_byte(i+1<len ? 1 : 0);
  }
  i2c_stop();
  return 0;
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateSoftSPI(outDir){
  const hname = 'soft_spi.h';
  const cname = 'soft_spi.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef SOFT_SPI_H
#define SOFT_SPI_H

#include <stdint.h>

void soft_spi_init(void);
uint8_t soft_spi_transfer(uint8_t v);
void soft_spi_select(void);
void soft_spi_release(void);

#endif
`;
  const c = `#include "soft_spi.h"
#include "soft_gpio.h"
#include "platform.h"
#include "board.h"

static void sclk_high(void){ gpio_write(GPIO_SCLK_PIN, 1); }
static void sclk_low(void){ gpio_write(GPIO_SCLK_PIN, 0); }
static void mosi_high(void){ gpio_write(GPIO_MOSI_PIN, 1); }
static void mosi_low(void){ gpio_write(GPIO_MOSI_PIN, 0); }
static uint8_t miso_read(void){ return gpio_read(GPIO_MISO_PIN); }

void soft_spi_init(void){
  gpio_init();
  gpio_set_dir(GPIO_SCLK_PIN, 1);
  gpio_set_dir(GPIO_MOSI_PIN, 1);
  gpio_set_dir(GPIO_MISO_PIN, 0);
  gpio_set_dir(GPIO_CS_PIN, 1);
  sclk_low(); mosi_low(); gpio_write(GPIO_CS_PIN, 1);
}

void soft_spi_select(void){ gpio_write(GPIO_CS_PIN, 0); }
void soft_spi_release(void){ gpio_write(GPIO_CS_PIN, 1); }

uint8_t soft_spi_transfer(uint8_t v){
  uint8_t r = 0;
  for(int i=7;i>=0;--i){
    if(v & (1u<<i)) mosi_high(); else mosi_low();
    delay_us(1);
    sclk_high(); delay_us(1);
    if(miso_read()) r |= (1u<<i);
    sclk_low(); delay_us(1);
  }
  return r;
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateADS7828(spec, outDir){
  // Generate a simple chip-level driver building on top of i2c.h
  const hname = 'ads7828.h';
  const cname = 'ads7828.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef ADS7828_H
#define ADS7828_H

#include <stdint.h>

#define ADS7828_ADDR 0x48

uint16_t ads7828_read_raw(uint8_t channel);
float ads7828_read_voltage(uint8_t channel, float vref);

#endif
`;
  const c = `#include "ads7828.h"
#include "i2c.h"

uint16_t ads7828_read_raw(uint8_t channel){
  uint8_t cmd = 0x80 | ((channel & 0x07) << 4);
  if(i2c_write(ADS7828_ADDR, &cmd, 1) != 0) return 0xFFFF;
  uint8_t buf[2] = {0,0};
  if(i2c_read(ADS7828_ADDR, buf, 2) != 0) return 0xFFFF;
  uint16_t raw = ((uint16_t)buf[0] << 8) | buf[1];
  raw >>= 4; // 12-bit
  return raw;
}

float ads7828_read_voltage(uint8_t channel, float vref){
  uint16_t raw = ads7828_read_raw(channel);
  if(raw == 0xFFFF) return -1.0f;
  return ((float)raw / 4095.0f) * (vref <= 0 ? 2.5f : vref);
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateUARTExample(outDir){
  const cname = 'uart_example.c';
  const cpath = path.join(outDir, cname);
  const c = `#include "uart.h"

void uart_demo(void){
  uart_init(115200);
  const char *msg = "UART demo\\n";
  for(const char *p = msg; *p; ++p){
    uart_send_byte((unsigned char)*p);
  }
}
`;
  safeFile(cpath, c);
  return [cname];
}

function generateMCP3008(outDir){
  const hname = 'mcp3008.h';
  const cname = 'mcp3008.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef MCP3008_H
#define MCP3008_H

#include <stdint.h>

void mcp3008_init(void);
uint16_t mcp3008_read(uint8_t channel);

#endif
`;
  const c = `#include "mcp3008.h"
#include "spi.h"

void mcp3008_init(void){
  spi_init_master();
}

uint16_t mcp3008_read(uint8_t channel){
  // Command: 1(start) | single-ended | channel bits
  uint8_t start = 0x01;
  uint8_t cfg = 0x80 | ((channel & 0x07) << 4);
  (void)start; // using single-byte xfers for clarity
  spi_transfer(start);
  uint8_t hi = spi_transfer(cfg);
  uint8_t lo = spi_transfer(0x00);
  uint16_t raw = ((uint16_t)(hi & 0x03) << 8) | lo;
  return raw;
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateW25Q(outDir){
  const hname = 'w25q.h';
  const cname = 'w25q.c';
  const hpath = path.join(outDir, hname);
  const cpath = path.join(outDir, cname);
  const h = `#ifndef W25Q_H
#define W25Q_H

#include <stdint.h>

void w25q_init(void);
void w25q_read_jedec_id(uint8_t *mid, uint8_t *did1, uint8_t *did2);

#endif
`;
  const c = `#include "w25q.h"
#include "spi.h"

void w25q_init(void){
  spi_init_master();
}

void w25q_read_jedec_id(uint8_t *mid, uint8_t *did1, uint8_t *did2){
  spi_transfer(0x9F);
  if(mid) *mid = spi_transfer(0x00);
  if(did1) *did1 = spi_transfer(0x00);
  if(did2) *did2 = spi_transfer(0x00);
}
`;
  safeFile(hpath, h);
  safeFile(cpath, c);
  return [hname, cname];
}

function generateTransistorExamples(spec, outDir){
  const arduinoName = 'transistor_pwm_arduino.ino';
  const stmName = 'transistor_pwm_stm32.c';
  const aPath = path.join(outDir, arduinoName);
  const sPath = path.join(outDir, stmName);
  const arduino = `// Arduino test for driving a PNP power transistor via NPN driver
// See README for wiring: emitter->+12V, collector->LOAD->GND, base pulled up via 10k, NPN pulls base low.

const int NPN_DRV_PIN = 9;      // PWM pin
const int SHUNT_ADC_PIN = A0;   // optional current sense input
const float RSHUNT = 0.1f;      // Ohms
const float ADC_REF = 5.0f;
const int ADC_RES = 1023;

void setup(){
  Serial.begin(115200);
  pinMode(NPN_DRV_PIN, OUTPUT);
  analogWrite(NPN_DRV_PIN, 0);
}

float read_current(){
  int raw = analogRead(SHUNT_ADC_PIN);
  float v = (raw / (float)ADC_RES) * ADC_REF;
  return v / RSHUNT;
}

void loop(){
  Serial.println("ON 50% PWM");
  analogWrite(NPN_DRV_PIN, 128);
  delay(2000);
  Serial.print("I(A)="); Serial.println(read_current(), 3);
  Serial.println("OFF");
  analogWrite(NPN_DRV_PIN, 0);
  delay(1000);
  for(int d=0; d<=255; d+=5){ analogWrite(NPN_DRV_PIN, d); delay(20);} 
  for(int d=255; d>=0; d-=5){ analogWrite(NPN_DRV_PIN, d); delay(20);} 
  analogWrite(NPN_DRV_PIN, 0);
  delay(1000);
}
`;
  const stm = `/* STM32 HAL PWM/ADC skeleton for PNP via NPN driver */
#include "main.h"

extern TIM_HandleTypeDef htim1; // configured by CubeMX
extern ADC_HandleTypeDef hadc1;

#define PWM_CH TIM_CHANNEL_1
#define RSHUNT 0.1f

static float read_current(void){
  HAL_ADC_Start(&hadc1);
  if(HAL_ADC_PollForConversion(&hadc1, 10) != HAL_OK) return -1.0f;
  uint32_t raw = HAL_ADC_GetValue(&hadc1);
  float v = (raw / 4095.0f) * 3.3f;
  return v / RSHUNT;
}

void app_run(void){
  HAL_TIM_PWM_Start(&htim1, PWM_CH);
  __HAL_TIM_SET_COMPARE(&htim1, PWM_CH, htim1.Init.Period/2);
  HAL_Delay(2000);
  (void)read_current();
  __HAL_TIM_SET_COMPARE(&htim1, PWM_CH, 0);
}
`;
  safeFile(aPath, arduino);
  safeFile(sPath, stm);
  return [arduinoName, stmName];
}

/**
 * Intelligently analyze datasheet content to determine what peripherals are actually present
 * This function makes the code generation truly dynamic based on datasheet content
 */
function analyzeDatasheetContent(spec, peripherals) {
  const detected = {};
  const deviceName = (spec.name || '').toLowerCase();
  const registers = spec.registers || [];
  
  console.log(`[ANALYZER] Analyzing datasheet for: ${spec.name || 'unknown device'}`);
  console.log(`[ANALYZER] Found ${registers.length} registers`);
  
  // Analyze registers to determine actual peripherals (STRICT mode - require strong evidence)
  const registerNames = registers.map(r => (r.name || '').toLowerCase());
  const registerText = registerNames.join(' ');
  
  // Count matches to avoid false positives
  const countMatches = (indicators) => {
    return indicators.reduce((count, indicator) => {
      const inText = registerText.includes(indicator);
      const inNames = registerNames.some(name => name.includes(indicator));
      return count + (inText || inNames ? 1 : 0);
    }, 0);
  };
  
  // GPIO Detection - STRICT: require multiple strong GPIO indicators
  const gpioStrongIndicators = ['gpio', 'gpio_', 'pinconfig', 'pinmux'];
  const gpioWeakIndicators = ['pin', 'port', 'dir', 'out', 'in'];
  const gpioStrongCount = countMatches(gpioStrongIndicators);
  const gpioWeakCount = countMatches(gpioWeakIndicators);
  const hasGpioRegisters = gpioStrongCount >= 1 || (gpioWeakCount >= 2 && gpioStrongCount >= 1);
  
  if (hasGpioRegisters || peripherals.gpio) {
    detected.gpio = peripherals.gpio || { pins: 32 };
    console.log(`[ANALYZER] ✓ GPIO detected (strong: ${gpioStrongCount}, weak: ${gpioWeakCount})`);
  }
  
  // UART Detection - STRICT: require multiple UART indicators
  const uartStrongIndicators = ['uart', 'usart', 'uart_', 'uart_data', 'uart_ctrl'];
  const uartWeakIndicators = ['serial', 'tx', 'rx', 'baud', 'thr', 'rbr', 'lsr', 'txd', 'rxd'];
  const uartStrongCount = countMatches(uartStrongIndicators);
  const uartWeakCount = countMatches(uartWeakIndicators);
  const hasUartRegisters = uartStrongCount >= 1 || (uartWeakCount >= 2 && uartStrongCount >= 0);
  
  if (hasUartRegisters || peripherals.uart) {
    detected.uart = peripherals.uart || { instances: [{ name: 'UART0', baud: 115200 }] };
    console.log(`[ANALYZER] ✓ UART detected (strong: ${uartStrongCount}, weak: ${uartWeakCount})`);
  }
  
  // SPI Detection - STRICT: require multiple SPI indicators
  const spiStrongIndicators = ['spi', 'spi_', 'spidat', 'spibuf', 'spictrl', 'spigcr', 'spifmt'];
  const spiWeakIndicators = ['sclk', 'mosi', 'miso', 'cs', 'ss'];
  const spiStrongCount = countMatches(spiStrongIndicators);
  const spiWeakCount = countMatches(spiWeakIndicators);
  const hasSpiRegisters = spiStrongCount >= 1 || (spiWeakCount >= 2 && spiStrongCount >= 0);
  
  if (hasSpiRegisters || peripherals.spi) {
    detected.spi = peripherals.spi || {};
    console.log(`[ANALYZER] ✓ SPI detected (strong: ${spiStrongCount}, weak: ${spiWeakCount})`);
  }
  
  // I2C Detection - STRICT: require multiple I2C indicators
  const i2cStrongIndicators = ['i2c', 'i2c_', 'iic', 'iic_', 'i2cctrl', 'i2cdata', 'i2cstat', 'i2caddr'];
  const i2cWeakIndicators = ['sda', 'scl', 'i2ccon', 'i2cclk'];
  const i2cStrongCount = countMatches(i2cStrongIndicators);
  const i2cWeakCount = countMatches(i2cWeakIndicators);
  const hasI2cRegisters = i2cStrongCount >= 1 || (i2cWeakCount >= 2 && i2cStrongCount >= 0);
  
  if (hasI2cRegisters || peripherals.i2c) {
    detected.i2c = peripherals.i2c || {};
    console.log(`[ANALYZER] ✓ I2C detected (strong: ${i2cStrongCount}, weak: ${i2cWeakCount})`);
  }
  
  // ADC Detection - STRICT: require multiple ADC indicators
  const adcStrongIndicators = ['adc', 'adc_', 'adcctrl', 'adcdata', 'adcstat', 'adcsel'];
  const adcWeakIndicators = ['analog', 'convert', 'adcch', 'adcstart'];
  const adcStrongCount = countMatches(adcStrongIndicators);
  const adcWeakCount = countMatches(adcWeakIndicators);
  const hasAdcRegisters = adcStrongCount >= 1 || (adcWeakCount >= 2 && adcStrongCount >= 0);
  
  if (hasAdcRegisters || peripherals.adc || /\badc\b/i.test(deviceName)) {
    detected.adc = peripherals.adc || {};
    console.log(`[ANALYZER] ✓ ADC detected (strong: ${adcStrongCount}, weak: ${adcWeakCount})`);
  }
  
  // Timer Detection - STRICT: only if explicitly present
  const timerIndicators = ['timer', 'tim', 'timctrl', 'timstat', 'timval', 'tim_'];
  const timerCount = countMatches(timerIndicators);
  const hasTimerRegisters = timerCount >= 2;
  
  if (hasTimerRegisters) {
    detected.timer = true;
    console.log(`[ANALYZER] ✓ Timer detected (count: ${timerCount})`);
  }
  
  // Interrupt Detection - STRICT: only if explicitly present
  const interruptIndicators = ['interrupt', 'irq', 'int', 'isr', 'nvic', 'intctrl', 'intstat'];
  const interruptCount = countMatches(interruptIndicators);
  const hasInterruptRegisters = interruptCount >= 2;
  
  if (hasInterruptRegisters) {
    detected.interrupts = true;
    console.log(`[ANALYZER] ✓ Interrupts detected (count: ${interruptCount})`);
  }
  
  // Debug Detection - only if UART is present (for debug output)
  if (detected.uart) {
    detected.debug = true;
    console.log(`[ANALYZER] ✓ Debug (UART-based) detected`);
  }
  
  // Special case: If no peripherals detected but we have registers, assume basic GPIO
  if (Object.keys(detected).length === 0 && registers.length > 0) {
    detected.gpio = { pins: 32 };
    console.log(`[ANALYZER] ⚠ No specific peripherals detected, assuming basic GPIO`);
  }
  
  // Special case: Analog devices (transistors, op-amps, etc.)
  const isAnalogDevice = /\b(transistor|pnp|npn|bjt|op-amp|opamp|analog|sensor|amplifier)\b/i.test(deviceName);
  if (isAnalogDevice) {
    // For analog devices, don't generate digital peripherals unless explicitly found
    console.log(`[ANALYZER] ⚠ Analog device detected, limiting digital peripherals`);
  }
  
  console.log(`[ANALYZER] Final detected peripherals:`, Object.keys(detected));
  return detected;
}

/**
 * Generate consolidated firmware file with ONLY detected peripherals
 */
function generateConsolidatedFirmware(spec, detectedPeripherals){
  const deviceName = (spec.name || 'firmware').replace(/[^a-zA-Z0-9]/g, '_');
  const headerGuard = deviceName.toUpperCase() + '_H';
  
  let content = `/*
 * Generated firmware drivers for ${spec.name || 'device'}
 * This is a consolidated file containing ONLY the peripherals found in the datasheet
 * Generated on: ${new Date().toISOString()}
 * Detected peripherals: ${Object.keys(detectedPeripherals).join(', ') || 'none'}
 */

#ifndef ${headerGuard}
#define ${headerGuard}

#include <stdint.h>

// ============================================================================
// CONSTANTS AND DEFINITIONS
// ============================================================================

`;

  // Only include basic definitions if GPIO is detected
  if (detectedPeripherals.gpio) {
    content += `#define LED_DELAY_MS 1000
#define LED_PIN 0
#define BUTTON_PIN 1

// GPIO pin mapping for bit-banged buses
#define GPIO_SCL_PIN 0
#define GPIO_SDA_PIN 1
#define GPIO_SCLK_PIN 2
#define GPIO_MOSI_PIN 3
#define GPIO_MISO_PIN 4
#define GPIO_CS_PIN 5

// LED state enumeration
typedef enum { LED_OFF = 0, LED_ON = 1, LED_BLINK = 2 } led_state_t;

`;
  }

  // Only include bit operations if we have registers
  if (spec.registers && spec.registers.length > 0) {
    content += `// Bit operations macros
#define SET_BIT(REG, BIT)    ((REG) |= (1U << (BIT)))
#define CLEAR_BIT(REG, BIT)  ((REG) &= ~(1U << (BIT)))
#define TOGGLE_BIT(REG, BIT) ((REG) ^= (1U << (BIT)))
#define READ_BIT(REG, BIT)   (((REG) >> (BIT)) & 1U)

`;
  }

  content += `// ============================================================================
// REGISTER DEFINITIONS
// ============================================================================

`;

  // Add register definitions if available
  if(spec.registers && Array.isArray(spec.registers)){
    content += `// Auto-generated register offsets from ${spec.name || 'datasheet'}\n`;
    spec.registers.forEach(r => {
      const name = (r.name||'REG').toUpperCase().replace(/[^A-Z0-9]/g,'_');
      content += `#define ${name}_OFFSET ${r.offset || '0x00'}\n`;
    });
    content += `\n`;
  }

  // Add peripheral-specific register definitions ONLY for detected peripherals
  Object.keys(detectedPeripherals).forEach(periphKey => {
    const periph = detectedPeripherals[periphKey];
    if(periph && periph.regs && Array.isArray(periph.regs)){
      const base = getHex(periph.base, periph.base ? periph.base : `0x40000000`);
      content += `// ${periphKey.toUpperCase()} peripheral registers\n`;
      content += `#define ${periphKey.toUpperCase()}_BASE (${base})\n\n`;
      
      periph.regs.forEach(r => {
        const nm = (r.name||'REG').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
        const off = r.offset || '0x00';
        content += `// ${nm}\n`;
        if(r.reset || r.access){
          content += `// Reset: ${r.reset||'n/a'}, Access: ${r.access||'n/a'}\n`;
        }
        if(Array.isArray(r.fields)){
          r.fields.forEach(f => {
            const fn = (f.name||'FIELD').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
            const bit = typeof f.bit === 'number' ? f.bit : parseInt(f.bit||'0',10);
            const fdesc = (f.desc||'').replace(/\r?\n/g,' ');
            if(fdesc) content += `// Bit ${bit}: ${fn} - ${fdesc}\n`;
          });
        }
        content += `#define ${nm} (*((volatile uint32_t*)(${periphKey.toUpperCase()}_BASE + ${off})))\n`;
        if(Array.isArray(r.fields)){
          r.fields.forEach(f => {
            const fn = (f.name||'FIELD').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
            const bit = typeof f.bit === 'number' ? f.bit : parseInt(f.bit||'0',10);
            content += `#define ${nm}_${fn} (1U << ${bit})\n`;
          });
        }
        content += `\n`;
      });
    }
  });

  content += `// ============================================================================
// FUNCTION DECLARATIONS
// ============================================================================

`;

  // Only include function declarations for detected peripherals
  if (detectedPeripherals.gpio || detectedPeripherals.timer) {
    content += `// Platform functions
void delay_us(uint32_t us);

`;
  }

  if (detectedPeripherals.gpio) {
    content += `// GPIO functions
void gpio_init(void);
void gpio_set_dir(uint32_t pin, uint8_t out);
void gpio_write(uint32_t pin, uint8_t value);
uint8_t gpio_read(uint32_t pin);

`;
  }

  if (detectedPeripherals.timer) {
    content += `// Timer functions
void timer_init(void);
void timer_start(void);
void timer_delay_ms(uint32_t ms);

`;
  }

  if (detectedPeripherals.interrupts) {
    content += `// Interrupt functions
void gpio_isr(void);
void timer_isr(void);
void gpio_isr_handler(void);

`;
  }

  if (detectedPeripherals.debug) {
    content += `// Debug functions
void uart_send_string(const char *s);
void uart_send_hex8(uint8_t v);
void uart_send_hex16(uint16_t v);
void uart_send_uint(uint32_t v);
#define DBG_PRINT(msg) uart_send_string(msg)

`;
  }

  // Add peripheral-specific function declarations ONLY for detected peripherals
  if(detectedPeripherals.uart){
    content += `// UART functions
void uart_init(int baud);
void uart_send_byte(uint8_t b);
uint8_t uart_recv_byte(void);

`;
  }
  if(detectedPeripherals.spi){
    content += `// SPI functions
void spi_init(void);
static inline void spi_init_master(void){ spi_init(); }
uint8_t spi_transfer(uint8_t out);

`;
  }
  if(detectedPeripherals.i2c){
    content += `// I2C functions
void i2c_init(void);
int i2c_write(uint8_t addr, const uint8_t *buf, uint32_t len);
int i2c_read(uint8_t addr, uint8_t *buf, uint32_t len);

`;
  }
  if(detectedPeripherals.adc){
    content += `// ADC functions
void adc_init(void);
uint16_t adc_read(uint8_t channel);

`;
  }

  content += `// Main application
int main(void);

#endif // ${headerGuard}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

#ifdef ${headerGuard.replace('_H', '_IMPLEMENTATION')}

`;

  // Only include implementations for detected peripherals
  if (detectedPeripherals.gpio || detectedPeripherals.timer) {
    content += `// Platform delay implementation
void delay_us(uint32_t us){
  volatile uint32_t n = us * 60; // tune for your MCU clock
  while(n--){ __asm__ __volatile__("":::"memory"); }
}

`;
  }

  if (detectedPeripherals.gpio) {
    content += `// GPIO implementation
static volatile uint32_t *GPIO_DIR = (uint32_t*)0x40010000;
static volatile uint32_t *GPIO_OUT = (uint32_t*)0x40010004;
static volatile uint32_t *GPIO_IN  = (uint32_t*)0x40010008;

void gpio_init(void){
  *GPIO_DIR = 0x00000000; // Default: all inputs
}

void gpio_set_dir(uint32_t pin, uint8_t out){
  if(out) *GPIO_DIR |= (1u<<pin);
  else *GPIO_DIR &= ~(1u<<pin);
}

void gpio_write(uint32_t pin, uint8_t value){
  if(value) *GPIO_OUT |= (1u<<pin);
  else *GPIO_OUT &= ~(1u<<pin);
}

uint8_t gpio_read(uint32_t pin){
  return ((*GPIO_IN >> pin) & 1u);
}

`;
  }

  if (detectedPeripherals.timer) {
    content += `// Timer implementation
void timer_init(void){
  /* Replace with hardware timer init */
}

void timer_start(void){
  /* Replace with starting a hardware timer */
}

void timer_delay_ms(uint32_t ms){
  while(ms--){
    delay_us(1000);
  }
}

`;
  }

  if (detectedPeripherals.interrupts) {
    content += `// Interrupt implementation
__attribute__((weak)) void gpio_isr(void){
  // GPIO interrupt handler stub
}

__attribute__((weak)) void timer_isr(void){
  // Timer interrupt handler stub
}

__attribute__((weak)) void gpio_isr_handler(void){
  // User can override in application to handle button/LED toggle
}

`;
  }

  if (detectedPeripherals.debug) {
    content += `// Debug implementation
void uart_send_string(const char *s){
  if(!s) return;
  for(const char *p = s; *p; ++p){
    uart_send_byte((uint8_t)*p);
  }
}

static const char HEX_CHARS[16] = {
  '0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'
};

void uart_send_hex8(uint8_t v){
  uart_send_byte((uint8_t)HEX_CHARS[(v>>4)&0xF]);
  uart_send_byte((uint8_t)HEX_CHARS[v&0xF]);
}

void uart_send_hex16(uint16_t v){
  uart_send_hex8((uint8_t)(v>>8));
  uart_send_hex8((uint8_t)(v&0xFF));
}

void uart_send_uint(uint32_t v){
  char buf[11];
  int i = 0;
  if(v == 0){ uart_send_byte('0'); return; }
  while(v && i < (int)sizeof(buf)){
    uint32_t q = v / 10u;
    uint32_t r = v - q*10u;
    buf[i++] = (char)('0' + r);
    v = q;
  }
  while(i-- > 0){ uart_send_byte((uint8_t)buf[i]); }
}

`;
  }

  // Add peripheral implementations ONLY for detected peripherals
  if(detectedPeripherals.uart){
    const base = getHex(detectedPeripherals.uart.base, '0x40020000');
    const regs = (detectedPeripherals.uart.regs) || (spec.registers) || [];
    const dataOff = findOffset(regs, ['uart_data','txrx','thr','rbr','data'], '0x00');
    const statOff = findOffset(regs, ['uart_status','lsr','status'], '0x04');
    
    content += `// UART implementation
static volatile uint32_t *UART_DATA = (uint32_t*)(${base} + ${dataOff});
static volatile uint32_t *UART_STATUS = (uint32_t*)(${base} + ${statOff});

void uart_init(int baud){
  /* configure baud -> placeholder */
  (void)baud;
}

void uart_send_byte(uint8_t b){
  while((*UART_STATUS & 0x1)==0); // wait tx ready
  *UART_DATA = b;
}

uint8_t uart_recv_byte(void){
  while((*UART_STATUS & 0x2)==0); // wait rx ready
  return (uint8_t)(*UART_DATA & 0xFF);
}

`;
  }

  if(detectedPeripherals.spi){
    const base = getHex(detectedPeripherals.spi.base, '0x40030000');
    const regs = (detectedPeripherals.spi.regs) || (spec.registers) || [];
    const offSPIDAT1 = findExact(regs, ['SPIDAT1']) || findOffset(regs, ['spidat1','spidat','spi_data','txrx','dr','data'], '0x00');
    const offSPIBUF  = findExact(regs, ['SPIBUF'])  || findOffset(regs, ['spibuf','spi_buf','status','sr'], '0x04');
    const offSPIGCR0 = findExact(regs, ['SPIGCR0']) || findOffset(regs, ['spigcr0','ctrl0','control0','gcr0'], '0x00');
    const offSPIGCR1 = findExact(regs, ['SPIGCR1']) || findOffset(regs, ['spigcr1','ctrl1','control1','gcr1'], '0x04');
    const offSPIFMT0 = findExact(regs, ['SPIFMT0']) || findOffset(regs, ['spifmt0','fmt0','format0'], '0x10');
    
    content += `// SPI implementation
static volatile uint32_t *SPIGCR0 = (uint32_t*)(${base} + ${offSPIGCR0});
static volatile uint32_t *SPIGCR1 = (uint32_t*)(${base} + ${offSPIGCR1});
static volatile uint32_t *SPIFMT0 = (uint32_t*)(${base} + ${offSPIFMT0});
static volatile uint32_t *SPIDAT1 = (uint32_t*)(${base} + ${offSPIDAT1});
static volatile uint32_t *SPIBUF  = (uint32_t*)(${base} + ${offSPIBUF});

void spi_init(void){
  *SPIGCR0 = 0x00000000; // reset
  *SPIGCR1 = 0x00000001; // enable module
  *SPIFMT0 = 0x00000000; // default format
}

uint8_t spi_transfer(uint8_t out){
  *SPIDAT1 = out;
  while(((*SPIBUF) & 0x00010000u)==0u) { /* wait RX ready */ }
  return (uint8_t)((*SPIBUF) & 0xFF);
}

`;
  }

  if(detectedPeripherals.i2c){
    const base = getHex(detectedPeripherals.i2c.base, '0x40040000');
    const regs = (detectedPeripherals.i2c.regs) || (spec.registers) || [];
    const ctrlOff = findOffset(regs, ['i2c_ctrl','control','cr'], '0x00');
    const dataOff = findOffset(regs, ['i2c_data','txrx','dr','data'], '0x04');
    
    content += `// I2C implementation
static volatile uint32_t *I2C_CTRL = (uint32_t*)(${base} + ${ctrlOff});
static volatile uint32_t *I2C_DATA = (uint32_t*)(${base} + ${dataOff});

void i2c_init(void){
  /* configure */
}

int i2c_write(uint8_t addr, const uint8_t *buf, uint32_t len){
  (void)addr; (void)buf; (void)len;
  return 0; // 0 = success
}

int i2c_read(uint8_t addr, uint8_t *buf, uint32_t len){
  (void)addr; (void)buf; (void)len;
  return 0;
}

`;
  }

  if(detectedPeripherals.adc){
    const base = getHex(detectedPeripherals.adc && detectedPeripherals.adc.base, '0x40050000');
    const regs = (spec.registers) || [];
    const ctrlOff = findOffset(regs, ['adc_ctrl','control','cr'], '0x00');
    const chselOff = findOffset(regs, ['adc_ch','channel','chsel'], '0x04');
    const startOff = findOffset(regs, ['adc_start','start','swtrig'], '0x08');
    const statOff = findOffset(regs, ['adc_stat','status','sr'], '0x0C');
    const dataOff = findOffset(regs, ['adc_data','data','dr'], '0x10');
    
    content += `// ADC implementation
static volatile uint32_t *ADC_CTRL  = (uint32_t*)(${base} + ${ctrlOff});
static volatile uint32_t *ADC_CHSEL = (uint32_t*)(${base} + ${chselOff});
static volatile uint32_t *ADC_START = (uint32_t*)(${base} + ${startOff});
static volatile uint32_t *ADC_STAT  = (uint32_t*)(${base} + ${statOff});
static volatile uint32_t *ADC_DATA  = (uint32_t*)(${base} + ${dataOff});

void adc_init(void){
  *ADC_CTRL = 0x00000001; // enable
}

uint16_t adc_read(uint8_t channel){
  *ADC_CHSEL = (uint32_t)(channel & 0xFF);
  *ADC_START = 1u; // start conversion
  while(((*ADC_STAT) & 0x1u) == 0u) { /* wait EOC */ }
  return (uint16_t)(*ADC_DATA & 0x0FFF);
}

`;
  }

  // Add main application with ONLY detected peripherals
  content += `// ============================================================================
// MAIN APPLICATION
// ============================================================================

`;

  if (detectedPeripherals.gpio) {
    content += `typedef struct {
  uint8_t pin;
  uint8_t direction; // 0=input, 1=output
} gpio_config_t;

`;
  }

  if (detectedPeripherals.gpio) {
    content += `static void blink_demo(void){
  gpio_init();
  gpio_set_dir(LED_PIN, 1);
  while(1){
    gpio_write(LED_PIN, 1);
    timer_delay_ms(LED_DELAY_MS);
    gpio_write(LED_PIN, 0);
    timer_delay_ms(LED_DELAY_MS);
    break; // run once in demo
  }
}

static void button_toggle_demo(void){
  gpio_set_dir(BUTTON_PIN, 0);
  gpio_set_dir(LED_PIN, 1);
  uint8_t last = gpio_read(BUTTON_PIN);
  for(int i=0;i<50;i++){
    uint8_t now = gpio_read(BUTTON_PIN);
    if(now && !last){
      uint8_t v = gpio_read(LED_PIN);
      gpio_write(LED_PIN, !v);
    }
    last = now;
    timer_delay_ms(20);
  }
}

`;
  }

  if(detectedPeripherals.uart){
    content += `static void uart_echo_demo(void){
  uart_init(115200);
  DBG_PRINT("UART echo demo\\n");
  // echo 8 bytes then return
  for(int i=0;i<8;i++){
    uint8_t b = uart_recv_byte();
    uart_send_byte(b);
  }
}

`;
  }

  if(detectedPeripherals.adc){
    content += `static void adc_print_demo(void){
  adc_init();
  DBG_PRINT("ADC read demo\\n");
  // simple binary print over UART of channel 0 value (twice)
  for(int i=0;i<2;i++){
    uint16_t v = adc_read(0);
    uart_send_byte((uint8_t)(v >> 8));
    uart_send_byte((uint8_t)(v & 0xFF));
    timer_delay_ms(10);
  }
}

`;
  }

  if(detectedPeripherals.spi){
    content += `static void spi_demo(void){
  spi_init();
  uart_init(115200);
  DBG_PRINT("SPI xfer 0xA5 -> 0x");
  uint8_t r = spi_transfer(0xA5);
  uart_send_hex8(r);
  DBG_PRINT("\\n");
}

`;
  }

  if(detectedPeripherals.i2c){
    content += `static void i2c_temp_demo(void){
  i2c_init();
  uart_init(115200);
  DBG_PRINT("I2C temp mock read: 0x");
  uint8_t buf[2] = {0,0};
  (void)i2c_read(0x48, buf, 2);
  uart_send_hex8(buf[0]);
  uart_send_hex8(buf[1]);
  DBG_PRINT("\\n");
}

`;
  }

  if (detectedPeripherals.gpio) {
    content += `static void state_machine_demo(void){
  gpio_init();
  gpio_set_dir(LED_PIN,1);
  led_state_t state = LED_OFF;
  for(int i=0;i<20;i++){
    switch(state){
      case LED_OFF: gpio_write(LED_PIN,0); state = LED_ON; break;
      case LED_ON:  gpio_write(LED_PIN,1); state = LED_OFF; break;
      default: gpio_write(LED_PIN,0); state = LED_OFF; break;
    }
    timer_delay_ms(100);
  }
}

static void pwm_control_demo(void){
  gpio_init();
  gpio_set_dir(LED_PIN,1);
  // very rough software PWM demo
  for(int duty=0; duty<=100; duty+=10){
    for(int c=0;c<50;c++){
      int on_us = duty * 100; // 10ms period
      int off_us = (100-duty) * 100;
      gpio_write(LED_PIN,1); delay_us((uint32_t)on_us);
      gpio_write(LED_PIN,0); delay_us((uint32_t)off_us);
    }
  }
}

static volatile uint8_t g_led_state = 0;
void gpio_isr_handler(void){
  // toggle LED on interrupt
  g_led_state ^= 1u;
  gpio_write(LED_PIN, g_led_state);
}

static void gpio_interrupt_demo(void){
  gpio_init();
  gpio_set_dir(BUTTON_PIN, 0);
  gpio_set_dir(LED_PIN, 1);
  // In real HW you'd configure edge triggers and enable the NVIC/IRQ here.
  // This demo simply calls the handler as if an interrupt occurred.
  DBG_PRINT("GPIO interrupt demo (simulated)\\n");
  for(int i=0;i<3;i++){
    gpio_isr_handler();
    timer_delay_ms(200);
  }
}

static void struct_demo(void){
  gpio_config_t cfg = { LED_PIN, 1 };
  gpio_init();
  gpio_set_dir(cfg.pin, cfg.direction);
  gpio_write(cfg.pin, 1);
  timer_delay_ms(LED_DELAY_MS);
  gpio_write(cfg.pin, 0);
}

static void bitops_demo(void){
  static volatile uint32_t fake_reg = 0;
  // use TOGGLE_BIT to simulate LED toggling
  for(int i=0;i<4;i++){
    TOGGLE_BIT(fake_reg, 0);
    uint8_t v = (uint8_t)READ_BIT(fake_reg, 0);
    gpio_write(LED_PIN, v);
    timer_delay_ms(LED_DELAY_MS/2);
  }
}

`;
  }

  content += `int main(void){
`;

  if (detectedPeripherals.timer) {
    content += `  timer_init();
  timer_start();
  
`;
  }

  content += `  // Run demos based on detected peripherals
`;

  if (detectedPeripherals.gpio) {
    content += `  DBG_PRINT("Blink demo\\n"); 
  blink_demo();
  button_toggle_demo();
`;
  }

  if(detectedPeripherals.uart){
    content += `  uart_echo_demo();
`;
  }
  if(detectedPeripherals.adc){
    content += `  adc_print_demo();
`;
  }
  if(detectedPeripherals.spi){
    content += `  spi_demo();
`;
  }
  if(detectedPeripherals.i2c){
    content += `  i2c_temp_demo();
`;
  }

  if (detectedPeripherals.gpio) {
    content += `  state_machine_demo();
  pwm_control_demo();
  gpio_interrupt_demo();
  struct_demo();
  bitops_demo();
`;
  }

  content += `  
  while(1){}
  return 0;
}

#endif // ${headerGuard.replace('_H', '_IMPLEMENTATION')}
`;

  return content;
}

/**
 * generateFromSpec: main entry
 */
function generateFromSpec(spec, outDir, opts){
  // spec normalization
  const peripherals = (spec.peripherals || spec.periph || {});
  const filesCreated = [];

  // Analyze what peripherals are actually present in the datasheet
  const detectedPeripherals = analyzeDatasheetContent(spec, peripherals);
  
  console.log(`[GENERATOR] Detected peripherals:`, Object.keys(detectedPeripherals));
  console.log(`[GENERATOR] Register count:`, spec.registers ? spec.registers.length : 0);
  console.log(`[GENERATOR] Generating minimal Arduino code only`);
  
  // Generate minimal single-file Arduino code
  const minimalCode = generateMinimalArduinoCode(detectedPeripherals, outDir, spec);
  filesCreated.push(...minimalCode);

  console.log(`[GENERATOR] Generated ${filesCreated.length} file for ${spec.name || 'device'}`);
  console.log(`[GENERATOR] Detected peripherals: ${Object.keys(detectedPeripherals).join(', ')}`);
  return filesCreated;
}

module.exports = { generateFromSpec };
