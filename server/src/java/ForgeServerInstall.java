/*
 * Run the official Forge installer server action without its global TLS probe.
 * The probe checks files.minecraftforge.net and launchermeta.mojang.com before
 * any work; an unrelated failure there makes SimpleInstaller exit early. Forge's
 * server action still performs its normal HTTPS downloads and checksum checks.
 */
import java.io.File;

import net.minecraftforge.installer.SimpleInstaller;
import net.minecraftforge.installer.actions.Action;
import net.minecraftforge.installer.actions.Actions;
import net.minecraftforge.installer.actions.ProgressCallback;
import net.minecraftforge.installer.json.InstallV1;
import net.minecraftforge.installer.json.Util;

public final class ForgeServerInstall {
    private ForgeServerInstall() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            throw new IllegalArgumentException("Expected the Forge installer JAR path");
        }

        System.setProperty("java.net.preferIPv4Stack", "true");
        SimpleInstaller.headless = true;

        File installer = new File(args[0]).getCanonicalFile();
        InstallV1 profile = Util.loadInstallProfile();
        ProgressCallback monitor = ProgressCallback.withOutputs(System.out);
        Action serverInstall = Actions.SERVER.getAction(profile, monitor);
        if (!serverInstall.run(new File("."), installer)) {
            throw new IllegalStateException("Forge server install action did not complete successfully");
        }
    }
}
