#!/usr/bin/env node

/**
 * Traceback CLI - Terminal interface for firmware code error detection and fixing
 * 
 * Usage:
 *   node traceback-cli.js <code-directory> [options]
 * 
 * Options:
 *   --fix          Automatically apply fixes
 *   --no-compile   Skip compilation checks
 *   --no-static    Skip static analysis
 *   --no-ai        Skip AI-powered fixes
 *   --model <name> AI model to use (default: codellama:7b)
 *   --verbose      Show detailed output
 */

const { TracebackSystem } = require('./traceback');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const codeDir = args[0];
const options = {
  autoFix: args.includes('--fix'),
  useCompiler: !args.includes('--no-compile'),
  useStaticAnalysis: !args.includes('--no-static'),
  useAI: !args.includes('--no-ai'),
  verbose: args.includes('--verbose'),
  aiModel: args[args.indexOf('--model') + 1] || 'codellama:7b'
};

// Validate input
if (!codeDir) {
  console.error('❌ Error: Code directory required');
  console.log('\nUsage: node traceback-cli.js <code-directory> [options]');
  console.log('\nOptions:');
  console.log('  --fix          Automatically apply fixes');
  console.log('  --no-compile    Skip compilation checks');
  console.log('  --no-static     Skip static analysis');
  console.log('  --no-ai         Skip AI-powered fixes');
  console.log('  --model <name>  AI model to use (default: codellama:7b)');
  console.log('  --verbose       Show detailed output');
  process.exit(1);
}

if (!fs.existsSync(codeDir)) {
  console.error(`❌ Error: Directory "${codeDir}" does not exist`);
  process.exit(1);
}

// Main execution
async function main() {
  console.log('🔍 Starting traceback analysis...\n');
  console.log(`📁 Analyzing: ${path.resolve(codeDir)}`);
  console.log(`⚙️  Options:`, {
    autoFix: options.autoFix,
    useCompiler: options.useCompiler,
    useStaticAnalysis: options.useStaticAnalysis,
    useAI: options.useAI,
    aiModel: options.aiModel
  });
  console.log('');

  const traceback = new TracebackSystem(options);
  
  try {
    // Analyze code
    const results = await traceback.analyzeCode(codeDir);

    // Get AI fixes if enabled and errors found
    if (options.useAI && results.errors.length > 0) {
      console.log('🤖 Requesting AI-powered fix suggestions...');
      const codeFiles = fs.readdirSync(codeDir)
        .filter(f => f.endsWith('.c') || f.endsWith('.h') || f.endsWith('.cpp'))
        .map(f => path.join(codeDir, f));
      
      await traceback.getAIFixes(results.errors, codeFiles);
      results.fixes = traceback.fixes;
    }

    // Print report
    traceback.printReport(results);

    // Apply fixes if requested
    if (options.autoFix && results.fixes.length > 0) {
      console.log('🔧 Applying fixes...');
      const applied = await traceback.applyFixes(codeDir, results.fixes);
      
      if (applied.length > 0) {
        console.log(`\n✅ Applied ${applied.length} fixes:`);
        applied.forEach(fix => {
          console.log(`   ${fix.file}:${fix.line}`);
          console.log(`   - ${fix.old}`);
          console.log(`   + ${fix.new}`);
        });
        
        // Re-analyze after fixes
        console.log('\n🔍 Re-analyzing after fixes...');
        const newResults = await traceback.analyzeCode(codeDir);
        traceback.printReport(newResults);
      } else {
        console.log('⚠️  No fixes were applied');
      }
    }

    // Exit with appropriate code
    process.exit(results.errors.length > 0 ? 1 : 0);

  } catch (error) {
    console.error('\n❌ Traceback analysis failed:');
    console.error(error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();

