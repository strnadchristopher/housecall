import java.util.Properties
import java.net.URI
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.mapleavenuelabs.housecall"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.mapleavenuelabs.housecall"
        minSdk = 24
        targetSdk = 35
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        val authOrigin = providers.environmentVariable("HOUSECALL_AUTH_ORIGIN").orElse("").get()
        val authUri = if (authOrigin.isEmpty()) null else URI(authOrigin)
        require(authUri == null || (authUri.scheme == "https" && authUri.host != null &&
            authUri.host.matches(Regex("[a-z0-9]+(?:[.-][a-z0-9]+)*")) &&
            authOrigin == "https://${authUri.host}")) { "HOUSECALL_AUTH_ORIGIN must be a canonical HTTPS origin without a port or trailing slash" }
        buildConfigField("String", "AUTH_ORIGIN", "\"$authOrigin\"")
        val assetStatements = if (authUri == null) "[]" else "[{\"include\":\"$authOrigin/.well-known/assetlinks.json\"}]"
        resValue("string", "asset_statements", assetStatements.replace("\"", "\\\""))
        manifestPlaceholders["authHost"] = authUri?.host ?: "unconfigured.invalid"
        manifestPlaceholders["authAutoVerify"] = if (authUri == null) "false" else "true"
        // Public Firebase client identifiers, supplied explicitly by the app builder.
        // No service-account credentials or google-services.json are loaded.
        for (name in listOf("APPLICATION_ID", "API_KEY", "PROJECT_ID", "SENDER_ID")) {
            val value = providers.environmentVariable("HOUSECALL_FIREBASE_$name").orElse("").get()
            require(value.matches(Regex("[A-Za-z0-9_:.-]*"))) { "Invalid Firebase client configuration" }
            buildConfigField("String", "FIREBASE_$name", "\"$value\"")
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation(platform("com.google.firebase:firebase-bom:35.0.2"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
