// Sandpane JetBrains client — Gradle settings.
//
// Pins (verified against the Gradle Plugin Portal / Maven Central on 09.10.2026; build results in
// README.md "Checks actually run"): Gradle 9.8.1 (wrapper), IntelliJ Platform Gradle Plugin 2.19.0,
// Kotlin 2.4.21, foojay toolchain resolver 1.0.0.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        // JetBrains cache-redirector: mirrors IntelliJ Platform artifacts.
        maven("https://cache-redirector.jetbrains.com/intellij-dependencies")
        maven("https://cache-redirector.jetbrains.com/maven-central")
    }
}

plugins {
    // Lets Gradle auto-provision the JDK named by `javaToolchainVersion` (25) from the foojay
    // Disco API into ~/.gradle/jdks when no matching local JDK exists. No machine-specific JDK
    // path is ever committed; `org.gradle.java.home` stays unset.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

// No dependencyResolutionManagement block: the project's repositories block owns
// resolution (IntelliJ Platform artifacts are added there by the platform plugin).
rootProject.name = "sandpane-jetbrains"
