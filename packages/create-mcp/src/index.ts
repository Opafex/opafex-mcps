#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync, renameSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';

interface Options {
  dir: string;
  name: string;
  description: string;
  install: boolean;
  git: boolean;
}

function parseArgs(args: string[]): Options {
  const positional: string[] = [];
  let name: string | undefined;
  let description = 'An MCP server built with @opafex/mcp-shared';
  let install = true;
  let git = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' && args[i + 1]) {
      name = args[++i];
    } else if (arg === '--description' && args[i + 1]) {
      description = args[++i];
    } else if (arg === '--no-install') {
      install = false;
    } else if (arg === '--no-git') {
      git = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const dir = positional[0];
  if (!dir) {
    console.error('Error: Please provide a project directory name.\n');
    printHelp();
    process.exit(1);
  }

  return {
    dir,
    name: name || basename(dir),
    description,
    install,
    git,
  };
}

function printHelp(): void {
  console.log(`
Usage: npm create @opafex/mcp <directory> -- [options]

Create a new MCP server project with @opafex/mcp-shared.

Options:
  --name <name>          Package name (defaults to directory name)
  --description <desc>   Package description
  --no-install           Skip npm install
  --no-git               Skip git init
  -h, --help             Show this help message

Examples:
  npm create @opafex/mcp my-enrichment-tool
  npm create @opafex/mcp my-tool -- --name @myorg/mcp-tool --no-git
`);
}

function replaceInFile(filePath: string, replacements: [string, string][]): void {
  let content = readFileSync(filePath, 'utf-8');
  for (const [search, replace] of replacements) {
    content = content.split(search).join(replace);
  }
  writeFileSync(filePath, content, 'utf-8');
}

function run(): void {
  const options = parseArgs(process.argv.slice(2));
  const targetDir = resolve(process.cwd(), options.dir);

  if (existsSync(targetDir)) {
    const files = readdirSync(targetDir);
    if (files.length > 0) {
      console.error(`Error: Directory "${options.dir}" already exists and is not empty.`);
      process.exit(1);
    }
  }

  console.log(`\nCreating MCP server: ${options.name}\n`);

  // Copy template
  const templateDir = resolve(dirname(__dirname), 'template');
  cpSync(templateDir, targetDir, { recursive: true });
  // npm strips .gitignore from published tarballs, so the template ships it as `gitignore`
  renameSync(join(targetDir, 'gitignore'), join(targetDir, '.gitignore'));

  // Apply replacements
  const replacements: [string, string][] = [
    ['my-mcp-server', options.name],
    ['An MCP server built with @opafex/mcp-shared', options.description],
  ];

  // Replace in key files
  const filesToReplace = ['package.json', 'README.md', 'src/index.ts'];
  for (const file of filesToReplace) {
    const filePath = join(targetDir, file);
    if (existsSync(filePath)) {
      replaceInFile(filePath, replacements);
    }
  }

  // Update the bin field key in package.json (JSON-level replacement)
  const pkgPath = join(targetDir, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (pkgJson.bin && pkgJson.bin['my-mcp-server']) {
    const binValue = pkgJson.bin['my-mcp-server'];
    delete pkgJson.bin['my-mcp-server'];
    pkgJson.bin[options.name] = binValue;
  }
  writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');

  console.log('  Created project structure');

  // Git init
  if (options.git) {
    try {
      execSync('git init', { cwd: targetDir, stdio: 'ignore' });
      console.log('  Initialised git repository');
    } catch {
      console.log('  Skipped git init (git not available)');
    }
  }

  // Install dependencies
  if (options.install) {
    console.log('  Installing dependencies...\n');
    try {
      execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
      console.log('');
    } catch {
      console.log('\n  npm install failed — run it manually.');
    }
  }

  console.log(`Done! Your MCP server is ready.\n`);
  console.log('Next steps:\n');
  console.log(`  cd ${options.dir}`);
  if (!options.install) {
    console.log('  npm install');
  }
  console.log('  npm run build');
  console.log('  npm test');
  console.log('  npm start\n');
  console.log('To add a new tool:');
  console.log('  1. Define types in src/types.ts');
  console.log('  2. Add logic in src/services/');
  console.log('  3. Define the tool in src/tools/');
  console.log('  4. Wire it up in src/index.ts');
  console.log('  5. Add tests in tests/\n');
}

run();
