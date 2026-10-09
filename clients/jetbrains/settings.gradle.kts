// Sandpane JetBrains client — Gradle settings.
//
// JB0 PIN (UNVERIFIED on this host — no IntelliJ Platform artifact was resolved here):
//   Gradle 8.10.2 (host), IntelliJ Platform Gradle Plugin 2.x, Kotlin 2.0.x.
// Kept network-free at settings evaluation time on purpose: the repository
// declarations below are only contacted when a plugin/build script is resolved.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        // JetBrains cache-redirector: mirrors IntelliJ Platform artifacts.
        maven("https://cache-redirector.jetbrains.com/intellij-dependencies")
        maven("https://cache-redirector.jetbrains.com/maven-central")
    }
}

// No dependencyResolutionManagement block: the project's repositories block owns
// resolution (IntelliJ Platform artifacts are added there by the platform plugin).
rootProject.name = "sandpane-jetbrains"
