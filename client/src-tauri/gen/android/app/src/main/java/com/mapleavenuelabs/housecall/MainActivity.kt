package com.mapleavenuelabs.housecall

import android.os.Bundle
import android.content.Intent
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    InviteLinkInbox.capture(intent)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
  override fun onNewIntent(intent: Intent) {
    InviteLinkInbox.capture(intent)
    super.onNewIntent(intent)
    setIntent(intent)
  }
  override fun onResume() {
    super.onResume()
    PushRuntime.schedule(this)
  }
}
