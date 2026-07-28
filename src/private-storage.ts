/** Encryption-aware storage for operational records that can contain family data. */

import { StorageManager, type StoreName } from './storage.js';
import { SettingsManager } from './settings.js';
import { CryptoSession, isEncrypted, type EncryptedData } from './crypto.js';

export async function setPrivateRecord(store: StoreName, key: string, value: unknown): Promise<void> {
    if (!SettingsManager.isEncryptionEnabled()) {
        await StorageManager.set(store, key, value);
        return;
    }
    if (!CryptoSession.isUnlocked()) throw new Error('locked');
    await StorageManager.set(store, key, await CryptoSession.encrypt(JSON.stringify(value)));
}

export async function getPrivateRecord<T>(store: StoreName, key: string): Promise<T | null> {
    const stored = await StorageManager.get<T | EncryptedData>(store, key);
    if (stored === null) return null;
    if (!isEncrypted(stored)) {
        // Re-encrypt legacy plaintext the next time it is read while unlocked.
        if (SettingsManager.isEncryptionEnabled() && CryptoSession.isUnlocked()) {
            void setPrivateRecord(store, key, stored).catch(() => {});
        }
        return stored as T;
    }
    if (!CryptoSession.isUnlocked()) return null;
    return JSON.parse(await CryptoSession.decrypt(stored)) as T;
}
