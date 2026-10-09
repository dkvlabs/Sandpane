// Sandpane JetBrains plugin — Gradle build (IntelliJ Platform Gradle Plugin 2.x).
//
// Executed on the authoring host (results in README.md "Checks actually run"): Gradle 9.8.1,
// IntelliJ Platform Gradle Plugin 2.19.0, Kotlin 2.4.21, target IntelliJ IDEA 2026.2.3 (262),
// JDK 25 toolchain (auto-provisioned into ~/.gradle/jdks via the foojay resolver, settings.gradle.kts,
// when no local JDK 25 exists).
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    java
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    // Wire types in labs/dkv/sandpane/model/Models.kt are kotlinx.serialization
    // @Serializable classes; this compiler plugin is what makes them encode/decode.
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

kotlin {
    // Toolchain + bytecode target for this plugin's classes: IntelliJ IDEA 2026.2.3 (262) requires
    // Java 25 (see gradle.properties for the evidence). If no local JDK 25 exists, Gradle
    // provisions one via the foojay resolver.
    jvmToolchain(providers.gradleProperty("javaToolchainVersion").get().toInt())
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:${providers.gradleProperty("kotlinxSerializationVersion").get()}")

    intellijPlatform {
        // Unified IntelliJ IDEA distribution (no separate Community artifact since 2025.3).
        intellijIdea(providers.gradleProperty("platformVersion"))

        // JB0 OPEN ITEM (do not delete this note): specs brief asks for the
        // product-modules style `intellij { modules("intellij.platform.core") }`.
        // In the 2.x plugin the modules/product-parts API is not the same surface as
        // 1.x's `intellij {}` extension, and there is no verified 2.x equivalent for
        // `modules(...)` in this scaffold. This plugin only uses Tool Window, editor,
        // VCS-root and diff APIs, all of which resolve from the base IDE dependency
        // above, so NO bundled-plugin/module dependency is declared here rather than
        // guessing one. Add and PROVEN the exact declaration (`bundledPlugin(...)` or
        // the 2.x modules API) only when a feature needs APIs outside platform core —
        // first expected at JB3 (Java PSI refactor/inspection context).
        //   intellijPlatform { bundledPlugin("com.intellij.java") }   // pending JB0

        testFramework(TestFrameworkType.Platform)
        // `instrumentationTools()` was removed from IPGP 2.x; `javaCompiler()` is now applied by
        // default for code instrumentation.
        pluginVerifier()
    }

    testImplementation(kotlin("test"))
}

intellijPlatform {
    pluginConfiguration {
        id = "labs.dkv.sandpane"
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")
        // plugin.xml carries the human-readable description and the independence
        // notice; patchPluginXml only fills the build range below.
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = providers.gradleProperty("pluginUntilBuild")
        }
    }

    // Plugin Verifier: `current()` = the exact IDE this build compiles against (IntelliJ IDEA
    // 2026.2.3), i.e. the whole declared since/until range (262 / 262.*). Widening the range must
    // add the matching IDEs here (e.g. `create(...)`/`select {}`), never just edit the numbers.
    pluginVerification {
        ides {
            current()
        }
    }
}

tasks {
    buildSearchableOptions {
        enabled = providers.gradleProperty("enableBuildSearchableOptions").get().toBoolean()
    }

    test {
        useJUnit()
        // ProtocolDriftGuardTest reads the Rust sources and schemas to compare wire names against.
        // `-Dsandpane.repo.root=<checkout>` is forwarded to the test JVM so CI (or a human) can
        // point the gate at any tree; unset, the test walks up from its working directory.
        systemProperty("sandpane.repo.root", providers.gradleProperty("sandpaneRepoRoot").getOrElse(""))
    }

    // Keep the Kotlin warning surface visible: this scaffold has no baseline to
    // compare against, so `-Werror` stays off until JB0 records a clean build.
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
        compilerOptions {
            allWarningsAsErrors = false
            // Kotlin 2.2+ defaults to `-jvm-default=enable`, which emits compatibility stubs in
            // this plugin's classes for every default method of a platform Kotlin interface they
            // implement (e.g. ToolWindowFactory.getAnchor/getIcon/manage/isApplicable). Plugin
            // Verifier then reports those generated stubs as deprecated/experimental API usage
            // the sources never make. No other Kotlin module links against this plugin, so the
            // binary-compatibility stubs buy nothing: generate plain JVM default methods only.
            jvmDefault = org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode.NO_COMPATIBILITY
        }
    }
}
