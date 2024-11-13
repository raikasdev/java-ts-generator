import { processJavaSource } from './parser';
import { TypeScriptEmitter } from './emitter';
import { downloadMavenArtifact } from './maven';
import type { TypeDefinition } from './types';
import * as fs from 'fs/promises';
import * as path from 'path';
import extract from 'extract-zip';
import { tmpdir } from 'os';

async function main() {
  const repo = 'https://repo.papermc.io/repository/maven-public';
  const artifact = 'io.papermc.paper:paper-api:1.21.3-R0.1-SNAPSHOT';

  const types = new Map<string, TypeDefinition>();
  const modules = new Map<string, Set<TypeDefinition>>();

  try {
    // Download Maven artifact
    console.log('Downloading Maven artifact...');
    const jarPath = await downloadMavenArtifact(repo, artifact, true);

    // Create temp directory for extraction
    const extractDir = await fs.mkdtemp(path.join(tmpdir(), 'java-ts-bind'));
    console.log('Extracting JAR to', extractDir);
    await extract(jarPath, { dir: path.resolve(extractDir) });

    console.log('Processing Java files...');
    const files = await processDirectory(extractDir);
    const moduleTypes = await processJavaSource(files);
    // Jaa eri tiedostoihin meneviin tyyppeihin
    for (const type of moduleTypes) {
        // Group by base package (tld.domain)
        const basePackage = getBasePackage(type.package);
        if (!modules.has(basePackage)) {
            modules.set(basePackage, new Set());
        }
        modules.get(basePackage)!.add(type);
    }
    // Generate TypeScript definitions
    console.log('Generating TypeScript definitions...');
    const emitter = new TypeScriptEmitter(types);
    for (const [basePackage, moduleTypes] of modules) {
        const output = emitter.emitPackage(basePackage, Array.from(moduleTypes));
        const filename = `./output/${basePackage.replace(/\./g, '_')}.d.ts`;
        if (!(await fs.exists('./output'))) await fs.mkdir('./output');
        await fs.writeFile(filename, output);
        console.log('Generated', filename);
    }

    // Cleanup
    await fs.rm(extractDir, { recursive: true });
    await fs.rm(jarPath);
    
    console.log('Done!');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  async function processDirectory(dir: string) {
    let classes: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        classes = classes.concat(await processDirectory(fullPath));
      } else if (entry.name.endsWith('.java')) {
        classes.push(fullPath);
      }
    }

    return classes;
  }
}

function getBasePackage(packageName: string): string {
  const parts = packageName.split('.');
  if (parts.length < 2) return packageName;
  return parts.slice(0, 2).join('.');
}

main().catch(console.error);