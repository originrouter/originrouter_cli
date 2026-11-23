import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agyPromptContent } from './acpContent.js';

export const AGY_NATIVE_PROMPT_CAPABILITIES = Object.freeze({
  image: true, embeddedContext: true,
  imagePng: true, imageJpeg: true, imageWebp: false, imageGif: false,
});

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
        text += `\n\nUser attached an image at ${JSON.stringify(file)}. Inspect this image using your native file-reading tool when relevant.\n`;
      }
    }
    return { text, root };
  } catch (error) { if (root) rmSync(root, { recursive: true, force: true }); throw error; }
}
