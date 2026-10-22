import 'dotenv/config';
import { v2 as cloudinary } from 'cloudinary';
import { parseBody } from './snip8-session.js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

function sendJson(res, statusCode, data) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(data);
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-pin');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let body = req.body;
  if (!body) {
    body = await parseBody(req);
  } else if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }

  const imageBase64 = body.imageBase64 || body.image;
  const user_pin = (body.user_pin || req.headers['x-user-pin'] || body.pin || '').toString().trim();

  if (!imageBase64 || !user_pin) {
    return sendJson(res, 400, { error: 'Missing imageBase64 or user_pin parameter' });
  }

  try {
    // Fixed public_id per PIN ensures strict 1-image storage with no file accumulation
    const publicId = `snip8/snip8_user_${user_pin}_latest`;

    const uploadResponse = await cloudinary.uploader.upload(imageBase64, {
      public_id: publicId,
      overwrite: true,
      invalidate: true,
      resource_type: 'image',
      format: 'jpg',
    });

    return sendJson(res, 200, {
      success: true,
      secure_url: uploadResponse.secure_url,
      public_id: uploadResponse.public_id,
    });
  } catch (err) {
    console.error('Cloudinary upload failure:', err);
    return sendJson(res, 500, { error: err.message || 'Internal upload error' });
  }
}
