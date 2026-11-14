package com.mapleavenuelabs.housecall

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Identity and full pin histories, AES-GCM encrypted with a non-exportable
 * AndroidKeyStore key and kept in backup-excluded storage (same pattern as PushStore).
 * Corruption or an inaccessible key fails closed; never treated as an empty identity.
 */
internal object IdentityRecordStore {
    private const val ALIAS = "housecall.identity.v1"
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "identity-v1.enc"))
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    /** Opaque Rust-validated identity/pin records, under names distinct from sessions. */
    @Synchronized private fun read(context: Context): JSONObject {
        val f = file(context)
        if (!f.baseFile.exists()) return JSONObject()
        return run {
            val bytes = f.readFully()
            require(bytes.size in 29..8_000_000)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.updateAAD(ALIAS.toByteArray())
            val plaintext = cipher.doFinal(bytes, 12, bytes.size - 12)
            try { JSONObject(String(plaintext, Charsets.UTF_8)) } finally { plaintext.fill(0) }
        }
    }
    @Synchronized private fun write(context: Context, state: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(ALIAS.toByteArray())
        val bytes = state.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 7_900_000)
        val f = file(context)
        val stream = f.startWrite()
        try {
            stream.write(cipher.iv)
            val encrypted = try { cipher.doFinal(bytes) } finally { bytes.fill(0) }
            stream.write(encrypted)
            f.finishWrite(stream)
        } catch (error: Exception) {
            f.failWrite(stream)
            throw error
        }
    }
    @Synchronized fun get(context: Context, account: String): String? =
        read(context).let { if (it.has(account)) it.getString(account) else null }
    @Synchronized fun set(context: Context, account: String, value: String) {
        val state = read(context)
        state.put(account, value)
        write(context, state)
    }
    @Synchronized fun remove(context: Context, account: String) {
        val state = read(context)
        state.remove(account)
        write(context, state)
    }
}
