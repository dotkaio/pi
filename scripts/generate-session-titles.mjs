#!/usr/bin/env node
/**
 * Generate individual titles for all sessions based on first user message.
 * Run from repo root: node scripts/generate-session-titles.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SESSIONS_ROOT = path.join(process.env.HOME, '.pi/agent/sessions');

function extractFirstUserMessage(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message?.role === 'user') {
          const msg = entry.message;
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content.map(c => c.text || '').join(' ');
          }
          text = text.trim();
          if (text) return text;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function hasSessionName(filePath) {
  return false; // Always regenerate titles
}

function generateTitle(text) {
  // Aggressive cleaning: remove role prefixes, system prompts, paths, urls, code
  let cleaned = text
    .replace(/^(User|Assistant):\s*/gi, '')
    .replace(/You (Memory Extraction|Are Memory Extraction).*?Conversation/gi, '')
    .replace(/<skill[^>]*>/g, '')
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/[\/~][\w\-\./]+/g, '')
    .replace(/\b(Assistant|User|System)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Split into words, filter junk and stop words
  const stop = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','is','are','was','were','be','been','being','have','has','had','do','does','did','can','could','will','would','should','may','might','must','shall','this','that','these','those','it','its','from','by','as','about','into','through','during','before','after','above','below','between','under','again','further','then','once','you','your','me','my','we','our','hey','sup','yo']);
  const words = cleaned.split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(w => w.length > 2 && !stop.has(w.toLowerCase()) && !/^\d+$/.test(w));

  // Take first 4-6 meaningful words
  let titleWords = words.slice(0, 6);
  if (titleWords.length < 3) titleWords = words.slice(0, 8);

  let title = titleWords.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  if (!title || title.length < 3) title = 'Untitled Session';
  if (title.length > 55) title = title.slice(0, 52) + '...';
  return title;
}

function appendSessionInfo(filePath, name) {
  const entry = {
    type: 'session_info',
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    name: name.trim()
  };
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

function processDirectory(dir) {
  let updated = 0;
  let skipped = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = processDirectory(fullPath);
      updated += result.updated;
      skipped += result.skipped;
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (hasSessionName(fullPath)) {
        skipped++;
        continue;
      }
      const firstMsg = extractFirstUserMessage(fullPath);
      if (firstMsg) {
        const title = generateTitle(firstMsg);
        appendSessionInfo(fullPath, title);
        console.log(`Titled: ${entry.name} -> "${title}"`);
        updated++;
      } else {
        skipped++;
      }
    }
  }
  return { updated, skipped };
}

console.log('Generating titles for all sessions...');
const result = processDirectory(SESSIONS_ROOT);
console.log(`Done. Updated: ${result.updated}, Skipped (already named or no messages): ${result.skipped}`);