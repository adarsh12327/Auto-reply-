import { UiState } from '../models/uiState.js';

export async function setUiState(ownerId, key, data, ttlMs = 15 * 60 * 1000) {
  return UiState.findOneAndUpdate(
    { ownerId, key },
    { $set: { data, expiresAt: new Date(Date.now() + ttlMs) } },
    { upsert: true, new: true }
  );
}

export async function getUiState(ownerId, key) {
  return UiState.findOne({ ownerId, key, expiresAt: { $gt: new Date() } });
}

export async function clearUiState(ownerId, key) {
  await UiState.deleteOne({ ownerId, key });
}
