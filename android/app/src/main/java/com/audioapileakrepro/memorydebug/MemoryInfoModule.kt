package com.audioapileakrepro.memorydebug

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.RandomAccessFile

/**
 * Reads this process's own resident memory straight from the kernel
 * (/proc/self/status), not via android.os.Debug/dumpsys - both of those
 * force an explicit GC pass as a side effect of measuring, which would
 * mask the exact leak this repro exists to demonstrate.
 */
class MemoryInfoModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "MemoryInfo"

  @ReactMethod
  fun getMemoryInfoKb(promise: Promise) {
    try {
      val result: WritableMap = Arguments.createMap()
      var rssKb = -1.0
      RandomAccessFile("/proc/self/status", "r").use { file ->
        var line = file.readLine()
        while (line != null) {
          if (line.startsWith("VmRSS:")) {
            rssKb = line.filter { it.isDigit() }.toDouble()
          }
          line = file.readLine()
        }
      }
      result.putDouble("rssKb", rssKb)
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("MEMORY_INFO_ERROR", e)
    }
  }
}
