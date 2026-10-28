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
}
