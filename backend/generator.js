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
 * generateFromSpec: main entry
 */
function generateFromSpec(spec, outDir, opts){
  // spec normalization
  const peripherals = (spec.peripherals || spec.periph || {});
  const filesCreated = [];

  // Always add README
  const readme = `Generated firmware drivers for ${spec.name||'ip'}.
This is a skeletal generated implementation intended as a starting point.
Please review addresses and register offsets before use.
`;
  fs.writeFileSync(path.join(outDir, 'README.txt'), readme, 'utf8');
  filesCreated.push('README.txt');

  if(peripherals.gpio){
    const gl = generateGPIO(peripherals.gpio, outDir, spec);
    filesCreated.push(...gl);
  }
  if(peripherals.uart){
    const ul = generateUART(peripherals.uart, outDir, spec);
    filesCreated.push(...ul);
    // Always include a small usage example for UART
    filesCreated.push(...generateUARTExample(outDir));
  }
  if(peripherals.spi){
    const sl = generateSPI(peripherals.spi, outDir, spec);
    filesCreated.push(...sl);
  }
  if(peripherals.i2c){
    const il = generateI2C(peripherals.i2c, outDir, spec);
    filesCreated.push(...il);
    filesCreated.push(...generateBoardConfig(outDir));
    filesCreated.push(...generatePlatformDelay(outDir));
    filesCreated.push(...generateSoftGPIO(outDir));
    filesCreated.push(...generateSoftI2C(outDir));
  }
  // Timers and interrupt stubs are useful across many projects; always include
  filesCreated.push(...generateTimers(outDir));
  filesCreated.push(...generateInterruptStubs(outDir));
  // Debug utilities for UART logging
  filesCreated.push(...generateDebug(outDir));
  // Constants and bit operations
  filesCreated.push(...generateConstants(outDir));
  filesCreated.push(...generateBitops(outDir));

  // ADC: include if specified or hinted in name
  if(peripherals.adc || /\badc\b/i.test(spec.name||'')){
    const al = generateADC(peripherals.adc || {}, outDir, spec);
    filesCreated.push(...al);
  }

  // If the name hints a specific device, add a high-level driver
  const name = (spec && spec.name || '').toLowerCase();
  if(name.includes('ads7828') || name.includes('i2c-adc')){
    const al = generateADS7828(spec, outDir);
    filesCreated.push(...al);
  }
  if(name.includes('mcp3008')){
    const ml = generateMCP3008(outDir);
    filesCreated.push(...ml);
  }
  if(name.includes('w25q') || name.includes('spi-flash') || name.includes('winbond')){
    const wl = generateW25Q(outDir);
    filesCreated.push(...wl);
  }
  if(name.includes('2sa1941') || name.includes('pnp') || name.includes('transistor')){
    const tl = generateTransistorExamples(spec, outDir);
    filesCreated.push(...tl);
  }

  // Create application entry with demos based on detected peripherals
  const perFlags = {
    gpio: !!peripherals.gpio,
    uart: !!peripherals.uart,
    spi:  !!peripherals.spi,
    i2c:  !!peripherals.i2c,
    adc:  !!peripherals.adc,
    timer: true,
    interrupts: true,
  };
  filesCreated.push(...generateMain(outDir, { peripherals: perFlags }));

  // If registers exist, create a registers.h (skip trivial placeholders and analog parts)
  if(spec.registers && Array.isArray(spec.registers)){
    const deviceName = ((spec.name||'') + '').toLowerCase();
    const looksAnalog = /\b(transistor|pnp|npn|bjt|op-amp|opamp|analog)\b/.test(deviceName);
    const regs = spec.registers.filter(Boolean);
    const isTrivial = regs.length === 2 &&
      /^ctrl$/i.test(regs[0].name||'') && (regs[0].offset||'').toString().toLowerCase()==='0x00' &&
      /^data$/i.test(regs[1].name||'') && (regs[1].offset||'').toString().toLowerCase()==='0x04';
    if(!looksAnalog && regs.length > 0 && !isTrivial){
      const rpath = path.join(outDir, 'registers.h');
      let rcontent = `#ifndef REGISTERS_H\n#define REGISTERS_H\n\n// Auto-generated register offsets\n\n`;
      regs.forEach(r => {
        const name = (r.name||'REG').toUpperCase().replace(/[^A-Z0-9]/g,'_');
        rcontent += `#define ${name}_OFFSET ${r.offset || '0x00'}\n`;
      });
      rcontent += `\n#endif\n`;
      fs.writeFileSync(rpath, rcontent, 'utf8');
      filesCreated.push('registers.h');
    }
  }

  return filesCreated;
}

module.exports = { generateFromSpec };
