// Sandpane JetBrains plugin — Gradle build (IntelliJ Platform Gradle Plugin 2.x).
//
// ┌────────────────────────────────────────────────────────────────────────────┐
// │ STATUS: NEVER EXECUTED. Written by inspection only.                        │
// │ The authoring host has Gradle 8.10.2 + JDK 23 but NO IntelliJ Platform     │
// │ artifacts and NO Kotlin compiler were resolved, so none of the DSL below is │
// │ proven. Every `version`/`type` literal is a JB0 pin to verify against the  │
// │ current Plugin SDK docs (docs/specs/04 §1, §4 JB0). See README.md.         │
// └────────────────────────────────────────────────────────────────────────────┘
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    java
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    // Wire types in labs/dkv/sandpane/model/Models.kt are kotlinx.serialization
    // @Serializable classes; this compiler plugin is what makes them encode/decode.
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
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
    // 242 ships on JBR 17; 252 runs on a newer JBR. Targeting the oldest supported
    // runtime keeps the class files loadable across the declared range.
    jvmToolchain(providers.gradleProperty("javaToolchainVersion").get().toInt())
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:${providers.gradleProperty("kotlinxSerializationVersion").get()}")

    intellijPlatform {
        create(
            providers.gradleProperty("platformType"),
            providers.gradleProperty("platformVersion"),
        )

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
        instrumentationTools()
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

    // JB0/JB4: run against older and newer Core within the compatibility policy.
    // `recommended()` needs a Team City/CD configuration; keep it explicit until then.
    pluginVerification {
        ides {
            recommended()
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
        }
    }
}
