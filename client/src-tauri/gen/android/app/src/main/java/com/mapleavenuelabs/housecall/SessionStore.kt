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
 * Signed-in sessions, one entry per server origin, AES-GCM encrypted with a non-exportable
 * AndroidKeyStore key and kept in backup-excluded storage (same pattern as PushStore).
 * A lost or invalid key drops every session: the person simply logs in again.
 */
internal object SessionStore {
    private const val ALIAS = "housecall.session.v1"
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "session-v1.enc"))
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
    /** `{ origin: sessionJsonString }`, plus `order` (most recent first). */
    @Synchronized private fun read(context: Context): JSONObject {
        val f = file(context)
        if (!f.baseFile.exists()) return JSONObject()
        return try {
            val bytes = f.readFully()
            require(bytes.size in 29..1_000_000)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.updateAAD(ALIAS.toByteArray())
            JSONObject(String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
        } catch (_: Exception) {
            clearAll(context)
            JSONObject()
        }
    }
    @Synchronized private fun write(context: Context, state: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(ALIAS.toByteArray())
        val bytes = state.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 900_000)
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
    @Synchronized fun get(context: Context, origin: String): String? {
        val state = read(context)
        return if (state.has(origin) && state.optString("order").contains(origin)) state.getString(origin) else null
    }
    @Synchronized fun set(context: Context, origin: String, session: String) {
        val state = read(context)
        state.put(origin, session)
        state.put("order", (listOf(origin) + origins(state).filter { it != origin }).take(10).joinToString("\n"))
        write(context, state)
    }
    @Synchronized fun remove(context: Context, origin: String) {
        val state = read(context)
        state.remove(origin)
        state.put("order", origins(state).filter { it != origin }.joinToString("\n"))
        write(context, state)
    }
    @Synchronized fun list(context: Context): List<String> = origins(read(context))
    private fun origins(state: JSONObject): List<String> =
        state.optString("order").split("\n").filter { it.isNotEmpty() && state.has(it) }
    @Synchronized fun clearAll(context: Context) {
        file(context).delete()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(ALIAS) }
    }
}
