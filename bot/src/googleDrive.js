import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { supabase } from './supabase.js';
import { log } from './utils/logger.js';

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

let oauth2Client = null;

function getOAuthClient() {
  if (!oauth2Client) {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
    }
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
  }
  return oauth2Client;
}

async function getRefreshToken() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('google_refresh_token')
    .limit(1)
    .single();

  if (error) throw new Error(`Failed to load Google credentials: ${error.message}`);
  if (!data?.google_refresh_token) {
    throw new Error('Google Drive not connected. Open the dashboard → Settings → Connect Google Drive.');
  }
  return data.google_refresh_token;
}

function getDriveClient(refreshToken) {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: client });
}

/**
 * Download a file from Google Drive.
 * @returns {Promise<{buffer: Buffer, name: string, mimeType: string}>}
 */
export async function downloadDriveFile(fileId) {
  const refreshToken = await getRefreshToken();
  const drive = getDriveClient(refreshToken);

  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType,size,trashed',
  });

  if (meta.data.trashed) {
    throw new Error('FILE_DELETED');
  }

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  return {
    buffer: Buffer.from(res.data),
    name: meta.data.name,
    mimeType: meta.data.mimeType,
  };
}

/**
 * Replace the contents of an existing Drive file (keeps the same fileId, so
 * any menu_items referencing it continue to work without DB changes).
 */
export async function replaceDriveFile(fileId, buffer, mimeType, newName) {
  const refreshToken = await getRefreshToken();
  const drive = getDriveClient(refreshToken);

  // Verify the file still exists and isn't trashed before overwriting.
  const meta = await drive.files.get({ fileId, fields: 'name,trashed' });
  if (meta.data.trashed) throw new Error('FILE_DELETED');

  const updateRequest = {
    fileId,
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: bufferToStream(buffer),
    },
    fields: 'id,name,mimeType,size,modifiedTime',
  };
  if (newName) updateRequest.requestBody = { name: newName };

  const updated = await drive.files.update(updateRequest);
  log.success(`Replaced Drive file ${fileId} (${updated.data.name}, ${updated.data.size} bytes)`);
  return updated.data;
}

/**
 * Upload a fresh file to Drive (under the user's "My Drive" root, or a
 * specific folder if folderId is provided). Returns the new file metadata.
 */
export async function uploadDriveFile(buffer, name, mimeType, folderId) {
  const refreshToken = await getRefreshToken();
  const drive = getDriveClient(refreshToken);

  const requestBody = { name };
  if (folderId) requestBody.parents = [folderId];

  const created = await drive.files.create({
    requestBody,
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: bufferToStream(buffer),
    },
    fields: 'id,name,mimeType,size,modifiedTime',
  });
  log.success(`Uploaded new Drive file ${created.data.id} (${created.data.name})`);
  return created.data;
}

/**
 * Mark a menu item's Drive file as missing in DB.
 */
export async function markFileMissing(itemId) {
  await supabase
    .from('menu_items')
    .update({ drive_file_missing: true })
    .eq('id', itemId);
  log.warn(`Marked menu item ${itemId} as missing file`);
}

/**
 * Mark a menu item as having a working file again (after replacement).
 */
export async function markFileFound(itemId) {
  await supabase
    .from('menu_items')
    .update({ drive_file_missing: false })
    .eq('id', itemId);
}
