import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { agyPromptContent } from './acpContent.js';

export const AGY_NATIVE_PROMPT_CAPABILITIES = Object.freeze({
  image: true, embeddedContext: true,
  imagePng: true, imageJpeg: true, imageWebp: false, imageGif: false,
});

function imageReference(path) {
  return `User attached an image at ${JSON.stringify(path)}. Inspect this image using your native file-reading tool when relevant.`;
}

// The paired App supplies bytes, never an arbitrary path or URL to fetch.
export function prepareAgyAttachments(message, content, directory) {
  const blocks = agyPromptContent(message, content, { image: true, embeddedContext: true });
  if (!blocks) throw new Error('invalid_attachment_content');
  let text = message || '';
  let root;
  try {
    for (const block of blocks) {
      if (block.type === 'resource') {
        const name = block.resource.uri.slice('originrouter-attachment:'.length).replace(/[\r\n\x00-\x1f]/g, ' ');
        text += `\n\nUser-supplied text attachment (${name}):\n${block.resource.text}\nEnd of attachment.\n`;
      } else if (block.type === 'image') {
        const bytes = Buffer.from(block.data, 'base64');
        if (!bytes.length || bytes.length > 512000 || bytes.toString('base64') !== block.data) throw new Error('invalid_image_data');
        const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        // Only signatures we can validate are advertised on the file-reference path.
        if (!((block.mimeType === 'image/png' && png) || (block.mimeType === 'image/jpeg' && jpeg))) throw new Error('image_type_not_supported');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        root ||= mkdtempSync(join(directory, 'agy-attachment-'));
        const file = join(root, `image-${blocks.indexOf(block)}.${png ? 'png' : 'jpg'}`);
        writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
        text += `\n\n${imageReference(file)}\n`;
      }
    }
    return { text, root };
  } catch (error) { if (root) rmSync(root, { recursive: true, force: true }); throw error; }
}

// A picker may reveal the queue owner after the native process received --add-dir.
// Restore into that process's private directory even on a delayed binding.
export function restoreAgyQueuedAttachment(entry, directory) {
  const root = realpathSync(entry.attachmentRoot);
  const session = dirname(root);
  const current = realpathSync(directory);
  if (dirname(session) !== dirname(current) || !basename(session).startsWith('session-')
      || !basename(root).startsWith('agy-attachment-')) throw new Error('invalid_attachment_root');
  if (session === current) return entry;
  const files = readdirSync(root, { withFileTypes: true });
  if (!files.length || files.length > 8 || files.some(file => !file.isFile() || !/^image-\d+\.(png|jpg)$/.test(file.name))) {
    throw new Error('invalid_attachment_root');
  }
  const destination = mkdtempSync(join(directory, 'agy-attachment-'));
  let text = entry.text;
  try {
    for (const { name } of files) {
      const reference = imageReference(join(entry.attachmentRoot, name));
      if (!text.includes(reference)) throw new Error('invalid_attachment_reference');
      const path = join(destination, name);
      copyFileSync(join(root, name), path);
      text = text.replaceAll(reference, () => imageReference(path));
    }
    return { ...entry, text, attachmentRoot: destination };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
