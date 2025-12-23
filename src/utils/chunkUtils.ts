import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePackageXml } from './manifestUtils.js';

export type ChunkConfig = {
  maxFilesPerChunk: number;
  maxComponentsPerChunk: number;
};

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxFilesPerChunk: 5000, // Max files per deployment
  maxComponentsPerChunk: 10_000, // Max components per deployment
};

/**
 * Splits a large type into multiple chunks.
 */
function splitLargeTypeIntoChunks(
  type: string,
  members: string[],
  maxComponentsPerChunk: number
): Array<{ [key: string]: Set<string> }> {
  const typeChunks: Array<{ [key: string]: Set<string> }> = [];

  for (let i = 0; i < members.length; i += maxComponentsPerChunk) {
    const chunkMembers = members.slice(i, i + maxComponentsPerChunk);
    typeChunks.push({ [type]: new Set(chunkMembers) });
  }

  return typeChunks;
}

/**
 * Checks if current chunk should be flushed before adding new type.
 */
function shouldFlushChunk(currentComponentCount: number, newTypeSize: number, maxComponentsPerChunk: number): boolean {
  return currentComponentCount + newTypeSize > maxComponentsPerChunk;
}

/**
 * Flushes the current chunk if not empty.
 */
function flushChunk(
  chunks: Array<{ [key: string]: Set<string> }>,
  currentChunk: { [key: string]: Set<string> },
  currentComponentCount: number
): { currentChunk: { [key: string]: Set<string> }; currentComponentCount: number } {
  if (currentComponentCount > 0) {
    chunks.push(currentChunk);
  }
  return { currentChunk: {}, currentComponentCount: 0 };
}

/**
 * Chunks metadata components into smaller groups for deployment.
 */
export function chunkMetadataComponents(
  metadataComponents: { [key: string]: Set<string> },
  config: ChunkConfig = DEFAULT_CHUNK_CONFIG
): Array<{ [key: string]: Set<string> }> {
  const chunks: Array<{ [key: string]: Set<string> }> = [];
  let currentChunk: { [key: string]: Set<string> } = {};
  let currentComponentCount = 0;

  const sortedTypes = Object.keys(metadataComponents).sort();

  for (const type of sortedTypes) {
    const members = Array.from(metadataComponents[type]);

    // Split large types into multiple chunks
    if (members.length > config.maxComponentsPerChunk) {
      const flushed = flushChunk(chunks, currentChunk, currentComponentCount);
      currentChunk = flushed.currentChunk;
      currentComponentCount = flushed.currentComponentCount;

      chunks.push(...splitLargeTypeIntoChunks(type, members, config.maxComponentsPerChunk));
      continue;
    }

    // Flush if adding this type would exceed limit
    if (shouldFlushChunk(currentComponentCount, members.length, config.maxComponentsPerChunk)) {
      const flushed = flushChunk(chunks, currentChunk, currentComponentCount);
      currentChunk = flushed.currentChunk;
      currentComponentCount = flushed.currentComponentCount;
    }

    // Add type to current chunk
    currentChunk[type] = new Set(members);
    currentComponentCount += members.length;
  }

  // Finalize chunks
  flushChunk(chunks, currentChunk, currentComponentCount);

  return chunks.length === 0 && Object.keys(metadataComponents).length > 0 ? [metadataComponents] : chunks;
}

/**
 * Chunks file paths into smaller groups.
 */
export function chunkFiles(files: string[], config: ChunkConfig = DEFAULT_CHUNK_CONFIG): string[][] {
  if (files.length <= config.maxFilesPerChunk) {
    return [files];
  }

  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += config.maxFilesPerChunk) {
    chunks.push(files.slice(i, i + config.maxFilesPerChunk));
  }

  return chunks;
}

/**
 * Generates chunked package manifests and writes them to disk.
 */
export function generateChunkedManifests(
  metadataComponents: { [key: string]: Set<string> },
  outputDir: string,
  version: string,
  config: ChunkConfig = DEFAULT_CHUNK_CONFIG
): string[] {
  const chunks = chunkMetadataComponents(metadataComponents, config);

  if (chunks.length <= 1) {
    // No chunking needed, return single manifest path
    const manifestPath = resolve(outputDir, 'package.xml');
    const manifestContent = generatePackageXml(metadataComponents, version);
    writeFileSync(manifestPath, manifestContent);
    return [manifestPath];
  }

  // Generate multiple chunked manifests
  const manifestPaths: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkNumber = i + 1;
    const manifestPath = resolve(outputDir, `package-chunk-${chunkNumber}.xml`);
    const manifestContent = generatePackageXml(chunks[i], version);
    writeFileSync(manifestPath, manifestContent);
    manifestPaths.push(manifestPath);
  }

  // Also generate a merged manifest for reference
  const mergedPath = resolve(outputDir, 'package-merged.xml');
  const mergedContent = generatePackageXml(metadataComponents, version);
  writeFileSync(mergedPath, mergedContent);
  manifestPaths.push(mergedPath);

  return manifestPaths;
}

/**
 * Merges multiple metadata component maps into one.
 */
export function mergeMetadataComponents(components: Array<{ [key: string]: Set<string> }>): {
  [key: string]: Set<string>;
} {
  const merged: { [key: string]: Set<string> } = {};

  for (const componentMap of components) {
    for (const [type, members] of Object.entries(componentMap)) {
      if (!merged[type]) {
        merged[type] = new Set<string>();
      }
      for (const member of members) {
        merged[type].add(member);
      }
    }
  }

  return merged;
}

/**
 * Generates a chunking report.
 */
export function generateChunkingReport(totalComponents: number, chunks: Array<{ [key: string]: Set<string> }>): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('                   CHUNKING REPORT');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Total Components: ${totalComponents}`);
  lines.push(`Total Chunks: ${chunks.length}`);
  lines.push('');

  if (chunks.length > 1) {
    lines.push('⚠️  Large changeset detected - split into multiple chunks');
    lines.push('');
    lines.push('Chunk Distribution:');

    chunks.forEach((chunk, index) => {
      const componentCount = Object.values(chunk).reduce((sum, set) => sum + set.size, 0);
      const typeCount = Object.keys(chunk).length;
      lines.push(`  Chunk ${index + 1}: ${componentCount} components across ${typeCount} types`);
    });

    lines.push('');
    lines.push('📝 Deploy these chunks sequentially for best results');
  } else {
    lines.push('✓ Changeset size is within limits - single deployment recommended');
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════');

  return lines.join('\n');
}
