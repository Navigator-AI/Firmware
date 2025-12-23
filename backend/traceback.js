const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
let axios = null;
try { axios = require('axios'); } catch(_) { axios = null; }

/**
 * Traceback System for Firmware Code Error Detection and Fixing
 * 
 * Features:
 * - Compilation error detection
 * - Static analysis (cppcheck, clang-tidy)
 * - Syntax error detection
 * - AI-powered fix suggestions
 * - Automatic error fixing
 */

class TracebackSystem {
  constructor(options = {}) {
    this.options = {
      useCompiler: options.useCompiler !== false, // Try to compile code
      useStaticAnalysis: options.useStaticAnalysis !== false, // Use cppcheck/clang-tidy
      useAI: options.useAI !== false, // Use Ollama for fixes
      // Default to a lightweight model to avoid OOM / long stalls
      aiModel: options.aiModel || 'qwen2.5:1.5b',
      // Use the same small model as fallback to avoid trying heavy models
      fallbackModel: options.fallbackModel || 'qwen2.5:1.5b',
      compiler: options.compiler || 'gcc', // gcc, clang, or arduino-cli
      verbose: options.verbose || false,
      autoFix: options.autoFix || false, // Automatically apply fixes
      ...options
    };
    this.errors = [];
    this.warnings = [];
    this.fixes = [];
  }

  /**
   * Analyze generated firmware code for errors
   */
  async analyzeCode(codeDir, files = null) {
    this.errors = [];
    this.warnings = [];
    this.fixes = [];

    if (!files) {
      files = fs.readdirSync(codeDir)
        .filter(f => f.endsWith('.c') || f.endsWith('.h') || f.endsWith('.cpp'));
    }

    const codeFiles = files.map(f => path.join(codeDir, f));

    // 1. Syntax validation
    await this.checkSyntax(codeFiles);

    // 2. Compilation check
    if (this.options.useCompiler) {
      await this.checkCompilation(codeDir, codeFiles);
    }

    // 3. Static analysis
    if (this.options.useStaticAnalysis) {
      await this.runStaticAnalysis(codeFiles);
    }

    // 4. Code quality checks
    await this.checkCodeQuality(codeFiles);

    return {
      errors: this.errors,
      warnings: this.warnings,
      fixes: this.fixes,
      summary: this.getSummary()
    };
  }

  /**
   * Basic syntax validation
   */
  async checkSyntax(files) {
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      
      // Check for common syntax errors
      const syntaxChecks = [
        {
          pattern: /[^;{}]\s*$/m,
          message: 'Missing semicolon or closing brace',
          type: 'syntax'
        },
        {
          pattern: /#include\s*<[^>]+$/m,
          message: 'Incomplete #include directive',
          type: 'syntax'
        },
        {
          pattern: /\([^)]*$/m,
          message: 'Unclosed parenthesis',
          type: 'syntax'
        },
        {
          pattern: /\[[^\]]*$/m,
          message: 'Unclosed bracket',
          type: 'syntax'
        },
        {
          pattern: /"[^"]*$/m,
          message: 'Unclosed string literal',
          type: 'syntax'
        }
      ];

      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        for (const check of syntaxChecks) {
          if (check.pattern.test(line) && !line.trim().endsWith('\\')) {
            this.errors.push({
              file: path.basename(file),
              line: idx + 1,
              column: line.length,
              message: check.message,
              type: check.type,
              code: line.trim(),
              severity: 'error'
            });
          }
        }
      });
    }
  }

  /**
   * Check if code compiles
   */
  async checkCompilation(codeDir, files) {
    const cFiles = files.filter(f => f.endsWith('.c') || f.endsWith('.cpp'));
    if (cFiles.length === 0) return;

    // Try GCC compilation
    try {
      const testFile = path.join(codeDir, '__test_compile.c');
      const allIncludes = this.extractIncludes(files);
      const allCode = this.combineCode(files);
      
      // Create a test compilation file
      const testCode = `${allIncludes.join('\n')}\n\n${allCode}`;
      fs.writeFileSync(testFile, testCode);

      const result = spawnSync(
        this.options.compiler,
        [
          '-c', testFile,
          '-o', path.join(codeDir, '__test_compile.o'),
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-I', codeDir
        ],
        { encoding: 'utf8', timeout: 10000 }
      );

      if (result.status !== 0) {
        const errorOutput = result.stderr || result.stdout || '';
        this.parseCompilerErrors(errorOutput, files);
      }

      // Cleanup
      try {
        fs.unlinkSync(testFile);
        const objFile = path.join(codeDir, '__test_compile.o');
        if (fs.existsSync(objFile)) fs.unlinkSync(objFile);
      } catch(e) {}
    } catch (err) {
      if (this.options.verbose) {
        console.warn(`[TRACEBACK] Compiler check skipped: ${err.message}`);
      }
    }
  }

  /**
   * Parse compiler error output
   */
  parseCompilerErrors(output, files) {
    // GCC/Clang error format: file:line:column: error: message
    const errorRegex = /([^:]+):(\d+):(\d+):\s*(error|warning):\s*(.+)/g;
    let match;

    while ((match = errorRegex.exec(output)) !== null) {
      const [, file, line, col, type, message] = match;
      const fileName = path.basename(file);
      const fullPath = files.find(f => f.includes(fileName) || fileName.includes(path.basename(f)));

      const error = {
        file: fileName,
        line: parseInt(line),
        column: parseInt(col),
        message: message.trim(),
        type: 'compilation',
        severity: type === 'error' ? 'error' : 'warning',
        code: this.getLineContent(fullPath || file, parseInt(line))
      };

      if (type === 'error') {
        this.errors.push(error);
      } else {
        this.warnings.push(error);
      }
    }

    // Also catch generic errors
    if (this.errors.length === 0 && output.includes('error:')) {
      const lines = output.split('\n').filter(l => l.includes('error:'));
      lines.forEach(line => {
        this.errors.push({
          file: 'unknown',
          line: 0,
          column: 0,
          message: line.replace(/error:\s*/, '').trim(),
          type: 'compilation',
          severity: 'error'
        });
      });
    }
  }

  /**
   * Run static analysis tools
   */
  async runStaticAnalysis(files) {
    // Try cppcheck
    await this.runCppcheck(files);
    
    // Try clang-tidy if available
    await this.runClangTidy(files);
  }

  /**
   * Run cppcheck static analyzer
   */
  async runCppcheck(files) {
    try {
      const cFiles = files.filter(f => f.endsWith('.c') || f.endsWith('.cpp'));
      if (cFiles.length === 0) return;

      const result = spawnSync(
        'cppcheck',
        [
          '--enable=all',
          '--std=c11',
          '--quiet',
          '--error-exitcode=0', // Don't exit on errors
          ...cFiles
        ],
        { encoding: 'utf8', timeout: 15000 }
      );

      if (result.stdout) {
        this.parseCppcheckOutput(result.stdout, files);
      }
    } catch (err) {
      if (this.options.verbose) {
        console.warn(`[TRACEBACK] cppcheck not available: ${err.message}`);
      }
    }
  }

  /**
   * Parse cppcheck output
   */
  parseCppcheckOutput(output, files) {
    // cppcheck format: [file:line]: (severity) message
    const regex = /\[([^:]+):(\d+)\]:\s*\((\w+)\)\s*(.+)/g;
    let match;

    while ((match = regex.exec(output)) !== null) {
      const [, file, line, severity, message] = match;
      const fileName = path.basename(file);
      const fullPath = files.find(f => f.includes(fileName));

      const issue = {
        file: fileName,
        line: parseInt(line),
        column: 0,
        message: message.trim(),
        type: 'static_analysis',
        severity: severity === 'error' ? 'error' : 'warning',
        code: this.getLineContent(fullPath || file, parseInt(line))
      };

      if (severity === 'error') {
        this.errors.push(issue);
      } else {
        this.warnings.push(issue);
      }
    }
  }

  /**
   * Run clang-tidy static analyzer
   */
  async runClangTidy(files) {
    try {
      const cFiles = files.filter(f => f.endsWith('.c') || f.endsWith('.cpp'));
      if (cFiles.length === 0) return;

      const result = spawnSync(
        'clang-tidy',
        [
          ...cFiles,
          '--',
          '-std=c11',
          '-I', path.dirname(cFiles[0])
        ],
        { encoding: 'utf8', timeout: 15000 }
      );

      if (result.stdout) {
        this.parseClangTidyOutput(result.stdout, files);
      }
    } catch (err) {
      if (this.options.verbose) {
        console.warn(`[TRACEBACK] clang-tidy not available: ${err.message}`);
      }
    }
  }

  /**
   * Parse clang-tidy output
   */
  parseClangTidyOutput(output, files) {
    const regex = /([^:]+):(\d+):(\d+):\s*(warning|error):\s*(.+?)\s*\[(.+?)\]/g;
    let match;

    while ((match = regex.exec(output)) !== null) {
      const [, file, line, col, severity, message, check] = match;
      const fileName = path.basename(file);
      const fullPath = files.find(f => f.includes(fileName));

      const issue = {
        file: fileName,
        line: parseInt(line),
        column: parseInt(col),
        message: `${message.trim()} [${check}]`,
        type: 'static_analysis',
        severity: severity === 'error' ? 'error' : 'warning',
        code: this.getLineContent(fullPath || file, parseInt(line))
      };

      if (severity === 'error') {
        this.errors.push(issue);
      } else {
        this.warnings.push(issue);
      }
    }
  }

  /**
   * Check code quality issues
   */
  async checkCodeQuality(files) {
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        // Check for undefined behavior patterns
        if (line.includes('volatile') && line.includes('*') && !line.includes('(')) {
          this.warnings.push({
            file: path.basename(file),
            line: idx + 1,
            column: 0,
            message: 'Potential undefined behavior with volatile pointer',
            type: 'quality',
            severity: 'warning',
            code: line.trim()
          });
        }

        // Check for uninitialized variables
        if (line.match(/\w+\s+\w+;/) && !line.includes('=') && !line.includes('extern') && !line.includes('static')) {
          this.warnings.push({
            file: path.basename(file),
            line: idx + 1,
            column: 0,
            message: 'Potentially uninitialized variable',
            type: 'quality',
            severity: 'warning',
            code: line.trim()
          });
        }
      });
    }
  }

  /**
   * Get AI-powered fix suggestions
   */
  async getAIFixes(errors, codeFiles) {
    if (!axios || !this.options.useAI) {
      return [];
    }

    const fixes = [];
    const primaryModel = this.options.aiModel || 'qwen2.5:1.5b';
    const fallbackModel = this.options.fallbackModel || null;
    const url = 'http://127.0.0.1:11434/api/generate';

    for (const error of errors.slice(0, 5)) { // Limit to 5 errors for performance
      try {
        const fileContent = this.getFileContent(error.file, codeFiles);
        const prompt = `Fix this C code error:

File: ${error.file}
Line: ${error.line}
Error: ${error.message}
Code context:
${this.getCodeContext(fileContent, error.line, 5)}

Provide ONLY the corrected code for the problematic line(s). No explanations.`;

        // Try primary model first, then optional fallback if we hit an OOM error
        const modelsToTry = [primaryModel];
        if (fallbackModel && fallbackModel !== primaryModel) modelsToTry.push(fallbackModel);

        let fixSuggestion = null;
        let lastError = null;

        for (const model of modelsToTry) {
          try {
            const response = await axios.post(
              url,
              {
                model,
                prompt,
                stream: false,
                // Do NOT request JSON mode here; some models 500 on format:'json'
                options: { temperature: 0.1, num_ctx: 4096 }
              },
              // Reduce timeout so a stuck model doesn't block the whole response for too long
              { timeout: 60000 } // 60s per error/model
            );

            const body = response?.data?.response || response?.data;

            // For traceback fixes we treat the LLM output as plain text code,
            // then aggressively strip markdown, line numbers, and notes so that
            // only the final corrected code ends up in the generated file.
            if (typeof body === 'string') {
              fixSuggestion = body;
            } else if (typeof body === 'object') {
              // Some Ollama versions wrap response differently
              if (typeof body.code === 'string') {
                fixSuggestion = body.code;
              } else if (typeof body.fix === 'string') {
                fixSuggestion = body.fix;
              } else if (typeof body.text === 'string') {
                fixSuggestion = body.text;
              } else {
                // Fallback: stringify object (last resort)
                fixSuggestion = JSON.stringify(body);
              }
            }

            // Clean up suggestion so it contains ONLY valid C/C++ code lines.
            fixSuggestion = this.sanitizeFixSuggestion(fixSuggestion || '');

            if (fixSuggestion) {
              // If this came from the fallback model, lower confidence slightly
              const confidence = model === primaryModel ? 0.8 : 0.7;
              fixes.push({
                error,
                suggestion: fixSuggestion,
                confidence
              });
            }

            // Success with this model; stop trying others
            lastError = null;
            break;
          } catch (innerErr) {
            lastError = innerErr;
            const msg =
              (innerErr && innerErr.response && innerErr.response.data && innerErr.response.data.error) ||
              innerErr.message ||
              '';

            // If this is a memory error and we have a fallback model, try the next model
            if (msg.toLowerCase().includes('requires more system memory') && model !== fallbackModel) {
              if (this.options.verbose) {
                console.warn(
                  `[TRACEBACK] Model "${model}" out of memory, falling back to "${fallbackModel}"`
                );
              }
              continue;
            }

            // If timeout and we have a fallback model, try the next model
            if ((innerErr.code === 'ECONNABORTED' || msg.includes('timeout')) && model !== fallbackModel && fallbackModel) {
              if (this.options.verbose) {
                console.warn(
                  `[TRACEBACK] Model "${model}" timed out, falling back to "${fallbackModel}"`
                );
              }
              continue;
            }

            // For other errors, don't keep trying models
            throw innerErr;
          }
        }

      } catch (err) {
        const errMsg = err.message || '';
        // Handle timeout gracefully - skip this error but continue with others
        if (err.code === 'ECONNABORTED' || errMsg.includes('timeout')) {
          if (this.options.verbose) {
            console.warn(
              `[TRACEBACK] AI fix timed out for ${error.file}:${error.line}, skipping...`
            );
          }
          // Continue to next error instead of breaking
          continue;
        }
        
        if (this.options.verbose) {
          console.warn(
            `[TRACEBACK] AI fix failed for ${error.file}:${error.line}: ${errMsg}`
          );
        }
        // On first hard failure (e.g. HTTP 500), stop trying further errors this run
        break;
      }
    }

    this.fixes = fixes;
    return fixes;
  }

  /**
   * Apply automatic fixes
   */
  async applyFixes(codeDir, fixes) {
    const applied = [];
    const fileMap = new Map();

    for (const fix of fixes) {
      const error = fix.error;
      const filePath = path.join(codeDir, error.file);
      
      if (!fs.existsSync(filePath)) continue;

      if (!fileMap.has(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        fileMap.set(filePath, content.split('\n'));
      }

      const lines = fileMap.get(filePath);
      const lineIdx = error.line - 1;

      if (lineIdx >= 0 && lineIdx < lines.length) {
        // Simple fix: replace the problematic line
        const oldLine = lines[lineIdx];
        lines[lineIdx] = fix.suggestion.trim();
        
        applied.push({
          file: error.file,
          line: error.line,
          old: oldLine,
          new: fix.suggestion.trim()
        });
      }
    }

    // Write back fixed files
    for (const [filePath, lines] of fileMap.entries()) {
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    }

    return applied;
  }

  /**
   * Helper: Extract includes from files
   */
  extractIncludes(files) {
    const includes = new Set();
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const matches = content.matchAll(/#include\s*[<"]([^>"]+)[>"]/g);
      for (const match of matches) {
        includes.add(`#include <${match[1]}>`);
      }
    }
    return Array.from(includes);
  }

  /**
   * Helper: Combine code from multiple files
   */
  combineCode(files) {
    return files
      .filter(f => fs.existsSync(f))
      .map(f => {
        const content = fs.readFileSync(f, 'utf8');
        // Remove includes, we'll add them separately
        return content.replace(/#include\s*[<"][^>"]+[>"]/g, '');
      })
      .join('\n\n');
  }

  /**
   * Helper: Get line content
   */
  getLineContent(filePath, lineNum) {
    try {
      if (!fs.existsSync(filePath)) return '';
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      return lines[lineNum - 1] || '';
    } catch {
      return '';
    }
  }

  /**
   * Helper: Get file content
   */
  getFileContent(fileName, codeFiles) {
    const filePath = codeFiles.find(f => f.includes(fileName) || fileName.includes(path.basename(f)));
    if (filePath && fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return '';
  }

  /**
   * Helper: Get code context around a line
   */
  getCodeContext(content, lineNum, contextLines = 5) {
    const lines = content.split('\n');
    const start = Math.max(0, lineNum - contextLines - 1);
    const end = Math.min(lines.length, lineNum + contextLines);
    const context = lines.slice(start, end);
    
    return context.map((line, idx) => {
      const actualLine = start + idx + 1;
      const marker = actualLine === lineNum ? '>>> ' : '    ';
      return `${marker}${actualLine}: ${line}`;
    }).join('\n');
  }

  /**
   * Get summary of analysis
   */
  getSummary() {
    return {
      totalErrors: this.errors.length,
      totalWarnings: this.warnings.length,
      totalFixes: this.fixes.length,
      errorTypes: this.groupByType(this.errors),
      warningTypes: this.groupByType(this.warnings)
    };
  }

  /**
   * Group errors/warnings by type
   */
  groupByType(issues) {
    const groups = {};
    for (const issue of issues) {
      groups[issue.type] = (groups[issue.type] || 0) + 1;
    }
    return groups;
  }

  /**
   * Print formatted report to terminal
   */
  printReport(results) {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 TRACEBACK ANALYSIS REPORT');
    console.log('='.repeat(80));

    if (results.errors.length === 0 && results.warnings.length === 0) {
      console.log('\n✅ No errors or warnings found!');
      return;
    }

    if (results.errors.length > 0) {
      console.log(`\n❌ ERRORS (${results.errors.length}):`);
      console.log('-'.repeat(80));
      results.errors.forEach((err, idx) => {
        console.log(`\n[${idx + 1}] ${err.file}:${err.line}:${err.column}`);
        console.log(`    Type: ${err.type}`);
        console.log(`    Message: ${err.message}`);
        if (err.code) {
          console.log(`    Code: ${err.code}`);
        }
      });
    }

    if (results.warnings.length > 0) {
      console.log(`\n⚠️  WARNINGS (${results.warnings.length}):`);
      console.log('-'.repeat(80));
      results.warnings.forEach((warn, idx) => {
        console.log(`\n[${idx + 1}] ${warn.file}:${warn.line}:${warn.column}`);
        console.log(`    Type: ${warn.type}`);
        console.log(`    Message: ${warn.message}`);
        if (warn.code) {
          console.log(`    Code: ${warn.code}`);
        }
      });
    }

    if (results.fixes.length > 0) {
      console.log(`\n🔧 FIX SUGGESTIONS (${results.fixes.length}):`);
      console.log('-'.repeat(80));
      results.fixes.forEach((fix, idx) => {
        const err = fix.error;
        console.log(`\n[${idx + 1}] ${err.file}:${err.line}`);
        console.log(`    Error: ${err.message}`);
        console.log(`    Suggested Fix:`);
        console.log(`    ${fix.suggestion.split('\n').join('\n    ')}`);
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log(`Summary: ${results.summary.totalErrors} errors, ${results.summary.totalWarnings} warnings`);
    console.log('='.repeat(80) + '\n');
  }

  /**
   * Sanitize LLM fix suggestion so that only clean C/C++ code remains.
   * Strips markdown fences, line numbers, ">>>", "Note:" text, etc.
   */
  sanitizeFixSuggestion(raw) {
    if (!raw || typeof raw !== 'string') return '';

    let text = raw.trim();

    // 1) If there are fenced code blocks (```), extract their contents.
    const fenceRegex = /```[\s\S]*?```/g;
    const fences = text.match(fenceRegex);
    if (fences && fences.length) {
      const codePieces = fences.map(block => {
        // Remove starting and ending ```
        return block
          .replace(/```[a-zA-Z0-9_]*/g, '')
          .replace(/```/g, '')
          .trim();
      });
      text = codePieces.join('\n').trim();
    }

    // 2) Split into lines and drop non-code / annotation lines.
    const outLines = [];
    const lines = text.split('\n');
    for (let line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip obvious annotations / explanations.
      if (trimmed.startsWith('>>>')) continue;
      if (/^```/.test(trimmed)) continue;
      if (/^Note[: ]/i.test(trimmed)) continue;
      if (/^\/\/\s*Note[: ]/i.test(trimmed)) continue;

      // Skip numbered-diff style prefixes: "1:", "3:", "12: #include ..."
      if (/^\d+\s*:?/.test(trimmed) && !trimmed.startsWith('#')) {
        const after = trimmed.replace(/^\d+\s*:?/, '').trim();
        if (!after) continue;
        line = after;
      }

      outLines.push(line);
    }

    const cleaned = outLines.join('\n').trim();
    return cleaned;
  }
}

module.exports = { TracebackSystem };

