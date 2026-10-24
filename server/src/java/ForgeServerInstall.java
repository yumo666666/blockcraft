/*
 * Run the official Forge installer server action without its global TLS probe.
 * The probe checks files.minecraftforge.net and launchermeta.mojang.com before
 * any work; an unrelated failure there makes SimpleInstaller exit early. Forge's
 * server action still performs its normal HTTPS downloads and checksum checks.
 */
import java.io.File;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.function.Predicate;

import net.minecraftforge.installer.SimpleInstaller;
import net.minecraftforge.installer.actions.Action;
import net.minecraftforge.installer.actions.Actions;
import net.minecraftforge.installer.actions.ProgressCallback;
import net.minecraftforge.installer.json.Install;
import net.minecraftforge.installer.json.InstallV1;
import net.minecraftforge.installer.json.Util;

public final class ForgeServerInstall {
    private ForgeServerInstall() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            throw new IllegalArgumentException("Expected the Forge installer JAR path, Maven mirror URL and optional Minecraft library mirror URL");
        }

        System.setProperty("java.net.preferIPv4Stack", "true");
        SimpleInstaller.headless = true;
        String mavenMirror = args[1].endsWith("/") ? args[1] : args[1] + "/";
        SimpleInstaller.mirror = new URL(mavenMirror);

        File installer = new File(args[0]).getCanonicalFile();
        // Forge's embedded profile hard-codes Mojang's library host, which the
        // installer deliberately excludes from its Maven mirror fallback. Route
        // those artifacts through the selected library mirror when configured;
        // Forge/Maven artifacts use the installer mirror above. Both keep the
        // installer-provided checksum verification.
        String profileJson;
        try (InputStream profileInput = ForgeServerInstall.class.getResourceAsStream("/install_profile.json")) {
            if (profileInput == null) throw new IllegalStateException("Forge installer is missing install_profile.json");
            profileJson = new String(profileInput.readAllBytes(), StandardCharsets.UTF_8);
        }
        if (!args[2].isBlank()) {
            profileJson = profileJson.replace(
                "https://libraries.minecraft.net/",
                args[2].replaceAll("/$", "") + "/"
            );
        }
        InstallV1 profile = new InstallV1(Util.GSON.fromJson(profileJson, Install.class));
        ProgressCallback monitor = ProgressCallback.withOutputs(System.out);
        Action serverInstall = Actions.SERVER.getAction(profile, monitor);
        boolean installed;
        try {
            // Forge installers through 52.1 expose run(File, File). Newer Forge
            // and NeoForge installers add a library filter before the installer
            // path, so keep the bridge compatible with both API generations.
            Method run = serverInstall.getClass().getMethod("run", File.class, File.class);
            installed = (boolean) run.invoke(serverInstall, new File("."), installer);
        } catch (NoSuchMethodException newerInstallerApi) {
            Method run = serverInstall.getClass().getMethod(
                "run", File.class, Predicate.class, File.class);
            try {
                installed = (boolean) run.invoke(
                    serverInstall,
                    new File("."),
                    (Predicate<String>) library -> true,
                    installer);
            } catch (InvocationTargetException e) {
                throw cause(e);
            }
        } catch (InvocationTargetException e) {
            throw cause(e);
        }
        if (!installed) {
            throw new IllegalStateException("Forge server install action did not complete successfully");
        }
    }

    private static Exception cause(InvocationTargetException exception) throws Error {
        Throwable cause = exception.getCause();
        if (cause instanceof Error) throw (Error) cause;
        if (cause instanceof Exception) return (Exception) cause;
        return exception;
    }
}
