package com.mapleavenuelabs.housecall

import android.os.Bundle
import android.content.Intent
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  var sensitiveSurface = false
  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
    if (sensitiveSurface && (event.flags and (android.view.MotionEvent.FLAG_WINDOW_IS_OBSCURED or android.view.MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED)) != 0) return false
    return super.dispatchTouchEvent(event)
  }
  override fun onDestroy() {
    sensitiveSurface = false
    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
    super.onDestroy()
  }
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
