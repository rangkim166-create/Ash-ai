plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ashjarvis"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ashjarvis"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    // Ship only the ARM64 APK used by the Galaxy A70, instead of a huge universal APK.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a")
            isUniversalApk = false
        }
    }

    // LLMEdge's AAR also carries legacy/SVE SmolLM variants that its Android
    // NativeLibraryCatalog never selects. Keep only the runtime's supported
    // baseline, ARMv8.2+dotprod, and ARMv8.4+i8mm candidates.
    packaging {
        jniLibs {
            excludes += setOf(
                "**/libsmollm_v8.so",
                "**/libsmollm_v8_2_fp16.so",
                "**/libsmollm_v8_4_fp16_dotprod.so",
                "**/libsmollm_v8_4_fp16_dotprod_sve.so",
                "**/libsmollm_v8_4_fp16_dotprod_i8mm_sve.so"
            )
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("io.github.aatricks:llmedge:0.3.9")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
}
