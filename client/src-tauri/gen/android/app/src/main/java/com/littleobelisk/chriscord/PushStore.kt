package com.littleobelisk.chriscord

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

/** Session and replay ledger never leave app-private, backup-excluded storage in plaintext. */
internal object PushStore {
    private const val ALIAS = "chriscord.push.session.v1"
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "push-v1.enc"))
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
    @Synchronized fun read(context: Context): JSONObject? {
        val f = file(context)
        if (!f.baseFile.exists()) return null
        return try {
            val bytes = f.readFully()
            require(bytes.size in 29..2_000_000)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.updateAAD(ALIAS.toByteArray())
            JSONObject(String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
        } catch (_: Exception) {
            // A lost/invalid key must never leave notifications trusted without their ledger.
            clear(context)
            PushRuntime.cancelAll(context)
            null
        }
    }
    @Synchronized fun write(context: Context, state: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(ALIAS.toByteArray())
        val bytes = state.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 1_900_000)
        val f = file(context)
        val stream = f.startWrite()
        try {
            stream.write(cipher.iv)
            stream.write(cipher.doFinal(bytes))
            f.finishWrite(stream)
        } catch (error: Exception) {
            f.failWrite(stream)
            throw error
        }
    }
    @Synchronized fun update(context: Context, generation: String, block: (JSONObject) -> Unit): Boolean {
        val current = read(context) ?: return false
        if (current.optString("generation") != generation) return false
        block(current)
        write(context, current)
        return true
    }
    @Synchronized fun clear(context: Context) {
        file(context).delete()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(ALIAS) }
    }
}
