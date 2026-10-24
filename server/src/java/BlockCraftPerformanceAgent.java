import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.instrument.Instrumentation;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryUsage;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** A dependency-free bridge from the server JVM/Spark API to BlockCraft's local sampler. */
public final class BlockCraftPerformanceAgent {
    private static final long PERIOD_MS = 2_000L;
    private static final long PLATFORM_REFRESH_MS = 5_000L;
    private static final long WORLD_REFRESH_MS = 30_000L;
    private static final Deque<GcReading> GC_HISTORY = new ArrayDeque<GcReading>();
    private static volatile Path output;
    private static volatile long startedAt;
    private static volatile long nextWorldRead;
    private static volatile long nextPlatformRead;
    private static volatile Double tps;
    private static volatile Double msptMean;
    private static volatile Double msptP95;
    private static volatile Double msptPeak;
    private static volatile Double pingMedian;
    private static volatile Double pingP95;
    private static volatile Double networkRx;
    private static volatile Double networkTx;
    private static volatile Double chunks;
    private static volatile Double entities;

    private BlockCraftPerformanceAgent() {}

    public static void premain(String argument, Instrumentation instrumentation) {
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(argument), StandardCharsets.UTF_8);
            output = new File(decoded).toPath();
            final Instrumentation loadedClasses = instrumentation;
            ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread thread = new Thread(r, "BlockCraft performance bridge");
                thread.setDaemon(true);
                return thread;
            });
            executor.scheduleAtFixedRate(() -> safelyCollect(loadedClasses), 0L, PERIOD_MS, TimeUnit.MILLISECONDS);
        } catch (Throwable ignored) {
            // Telemetry must never prevent a Minecraft server from starting.
        }
    }

    private static void safelyCollect(Instrumentation instrumentation) {
        try {
            long now = System.currentTimeMillis();
            MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
            long heapMax = heap.getMax() > 0L ? heap.getMax() : Runtime.getRuntime().maxMemory();
            GcReading gc = readGc(now);
            Map<String, Double> values = new HashMap<String, Double>();
            values.put("heapUsed", Double.valueOf(heap.getUsed()));
            values.put("heapMax", Double.valueOf(heapMax));
            values.put("gcCount", Double.valueOf(gc.count));
            values.put("gcPause", Double.valueOf(gc.pauseMs));

            Object spark = findSpark(instrumentation);
            if (spark != null) {
                Thread thread = Thread.currentThread();
                ClassLoader previousLoader = thread.getContextClassLoader();
                Object platform = field(spark, "platform");
                ClassLoader sparkLoader = platform == null
                    ? spark.getClass().getClassLoader()
                    : platform.getClass().getClassLoader();
                try {
                    // Forge/FML transforms classes using the thread context loader. The agent's
                    // scheduler inherits AppClassLoader, which cannot resolve Spark's shaded
                    // protobuf classes and caused all Spark platform statistics to fail.
                    if (sparkLoader != null && sparkLoader != previousLoader) {
                        thread.setContextClassLoader(sparkLoader);
                    }
                    collectTickStatistics(spark);
                    collectApiStatistics(spark);
                    collectSparkPing(spark);
                    if (now >= nextPlatformRead) {
                        boolean includeWorld = now >= nextWorldRead;
                        collectSparkNetwork(spark);
                        collectSparkPlatform(spark, includeWorld);
                        nextPlatformRead = now + PLATFORM_REFRESH_MS;
                        if (includeWorld) nextWorldRead = now + WORLD_REFRESH_MS;
                    }
                } finally {
                    if (thread.getContextClassLoader() != previousLoader) {
                        thread.setContextClassLoader(previousLoader);
                    }
                }
            }
            values.put("tps", tps);
            values.put("msptMean", msptMean);
            values.put("msptP95", msptP95);
            values.put("msptPeak", msptPeak);
            values.put("pingMedian", pingMedian);
            values.put("pingP95", pingP95);
            values.put("networkRx", networkRx);
            values.put("networkTx", networkTx);
            values.put("chunks", chunks);
            values.put("entities", entities);
            writeSnapshot(now, values);
        } catch (Throwable ignored) {
            // Keep the last snapshot; the Node side expires it if this thread stops updating.
        }
    }

    private static void collectTickStatistics(Object spark) {
        try {
            Object platform = field(spark, "platform");
            Object statistics = call(platform, "getTickStatistics");
            if (statistics == null) return;

            Double currentTps = number(call(statistics, "tps5Sec"));
            if (currentTps != null) tps = currentTps;
            if (!Boolean.TRUE.equals(call(statistics, "isDurationSupported"))) return;

            Object duration = call(statistics, "duration10Sec");
            Double mean = number(call(duration, "mean"));
            Double p95 = number(call(duration, "percentile95th"));
            Double peak = number(call(duration, "max"));
            if (mean != null) msptMean = mean;
            if (p95 != null) msptP95 = p95;
            if (peak != null) msptPeak = peak;
        } catch (Throwable ignored) { }
    }

    private static GcReading readGc(long now) {
        long count = 0L;
        long pause = 0L;
        for (GarbageCollectorMXBean bean : ManagementFactory.getGarbageCollectorMXBeans()) {
            if (bean.getCollectionCount() > 0L) count += bean.getCollectionCount();
            if (bean.getCollectionTime() > 0L) pause += bean.getCollectionTime();
        }
        synchronized (GC_HISTORY) {
            GC_HISTORY.addLast(new GcReading(now, count, pause));
            while (GC_HISTORY.size() > 1 && GC_HISTORY.peekFirst().at < now - 60_000L) GC_HISTORY.removeFirst();
            GcReading oldest = GC_HISTORY.peekFirst();
            return new GcReading(now, Math.max(0L, count - oldest.count), Math.max(0L, pause - oldest.pauseMs));
        }
    }

    private static Object findSpark(Instrumentation instrumentation) {
        for (Class<?> type : instrumentation.getAllLoadedClasses()) {
            if (!"me.lucko.spark.api.SparkProvider".equals(type.getName())) continue;
            try {
                Object api = type.getMethod("get").invoke(null);
                if (api != null) return api;
            } catch (Throwable ignored) {
                return null;
            }
        }
        return null;
    }

    private static void collectApiStatistics(Object spark) {
        try {
            Object statistic = call(spark, "tps");
            Object value = poll(statistic, "SECONDS_5");
            tps = number(value);
        } catch (Throwable ignored) { }
        try {
            Object statistic = call(spark, "mspt");
            Object value = poll(statistic, "SECONDS_10");
            msptMean = number(call(value, "mean"));
            msptP95 = number(call(value, "percentile95th"));
            msptPeak = number(call(value, "max"));
        } catch (Throwable ignored) { }
    }

    /** Read the Spark rolling ping summary without constructing a protobuf response. */
    private static void collectSparkPing(Object spark) {
        try {
            Object platform = field(spark, "platform");
            Object statistics = call(platform, "getPingStatistics");
            Object average = call(statistics, "getPingAverage");
            Double samples = number(call(average, "getSamples"));
            if (samples == null || samples.doubleValue() <= 0.0) return;

            Object summary = call(statistics, "currentSummary");
            Double total = number(call(summary, "total"));
            if (total == null || total.doubleValue() <= 0.0) return;
            Double median = number(call(summary, "median"));
            Double p95 = number(call(summary, "percentile95th"));
            if (median != null) pingMedian = median;
            if (p95 != null) pingP95 = p95;
        } catch (Throwable ignored) { }
    }

    /** Read Spark's rolling host NIC counters directly, without its shaded protobuf objects. */
    private static void collectSparkNetwork(Object spark) {
        try {
            Object platform = field(spark, "platform");
            ClassLoader loader = platform == null
                ? spark.getClass().getClassLoader()
                : platform.getClass().getClassLoader();
            Class<?> monitor = Class.forName("me.lucko.spark.common.monitor.net.NetworkMonitor", true, loader);
            Object interfaces = monitor.getMethod("systemAverages").invoke(null);
            if (!(interfaces instanceof Map<?, ?>)) return;

            double rx = 0.0;
            double tx = 0.0;
            boolean found = false;
            for (Object value : ((Map<?, ?>) interfaces).values()) {
                Double received = number(call(call(value, "rxBytesPerSecond"), "getMean"));
                Double sent = number(call(call(value, "txBytesPerSecond"), "getMean"));
                if (received != null || sent != null) found = true;
                if (received != null) rx += received.doubleValue();
                if (sent != null) tx += sent.doubleValue();
            }
            if (found) {
                networkRx = Double.valueOf(rx);
                networkTx = Double.valueOf(tx);
            }
        } catch (Throwable ignored) { }
    }

    private static Object poll(Object statistic, String window) throws Exception {
        if (statistic == null) return null;
        for (java.lang.reflect.Method method : statistic.getClass().getMethods()) {
            if (!"poll".equals(method.getName()) || method.getParameterTypes().length != 1) continue;
            Class<?> enumType = method.getParameterTypes()[0];
            if (!enumType.isEnum()) continue;
            Object[] constants = enumType.getEnumConstants();
            for (Object constant : constants) {
                if (window.equals(((Enum<?>) constant).name())) {
                    method.setAccessible(true);
                    return method.invoke(statistic, constant);
                }
            }
        }
        return null;
    }

    private static void collectSparkPlatform(Object spark, boolean includeWorld) {
        try {
            Object platform = field(spark, "platform");
            if (platform == null) return;
            Object provider = call(platform, "getStatisticsProvider");
            if (provider == null) return;
            Object system = call(provider, "getSystemStatistics");
            Object interfaces = call(system, "getNetMap");
            if (interfaces instanceof Map<?, ?>) {
                double rx = 0.0;
                double tx = 0.0;
                boolean found = false;
                for (Object value : ((Map<?, ?>) interfaces).values()) {
                    Object rxAvg = call(value, "getRxBytesPerSecond");
                    Object txAvg = call(value, "getTxBytesPerSecond");
                    Double r = number(call(rxAvg, "getMean"));
                    Double t = number(call(txAvg, "getMean"));
                    if (r != null || t != null) found = true;
                    if (r != null) rx += r.doubleValue();
                    if (t != null) tx += t.doubleValue();
                }
                if (found) { networkRx = Double.valueOf(rx); networkTx = Double.valueOf(tx); }
            }

            Object platformStatistics = invokePlatformStatistics(provider, includeWorld);
            if (platformStatistics == null) return;
            if (isTrue(call(platformStatistics, "hasTps"))) {
                Object tpsInfo = call(platformStatistics, "getTps");
                Double value = number(call(tpsInfo, "getLast1m"));
                if (value != null) tps = value;
            }
            if (isTrue(call(platformStatistics, "hasMspt"))) {
                Object msptInfo = call(platformStatistics, "getMspt");
                Object rolling = call(msptInfo, "getLast1m");
                Double mean = number(call(rolling, "getMean"));
                Double p95 = number(call(rolling, "getPercentile95"));
                Double peak = number(call(rolling, "getMax"));
                if (mean != null) msptMean = mean;
                if (p95 != null) msptP95 = p95;
                if (peak != null) msptPeak = peak;
            }
            if (isTrue(call(platformStatistics, "hasPing"))) {
                Object pingInfo = call(platformStatistics, "getPing");
                Object rolling = call(pingInfo, "getLast15m");
                Double median = number(call(rolling, "getMedian"));
                Double p95 = number(call(rolling, "getPercentile95"));
                if (median != null) pingMedian = median;
                if (p95 != null) pingP95 = p95;
            }
            if (includeWorld && isTrue(call(platformStatistics, "hasWorld"))) {
                Object world = call(platformStatistics, "getWorld");
                entities = number(call(world, "getTotalEntities"));
                int chunkCount = 0;
                Object worlds = call(world, "getWorldsList");
                if (worlds instanceof Iterable<?>) {
                    for (Object worldInfo : (Iterable<?>) worlds) {
                        Object regions = call(worldInfo, "getRegionsList");
                        if (!(regions instanceof Iterable<?>)) continue;
                        for (Object region : (Iterable<?>) regions) {
                            Object count = call(region, "getChunksCount");
                            Double numeric = number(count);
                            if (numeric != null) chunkCount += numeric.intValue();
                        }
                    }
                }
                chunks = Double.valueOf(chunkCount);
            }
        } catch (Throwable ignored) { }
    }

    private static Object invokePlatformStatistics(Object provider, boolean includeWorld) throws Exception {
        for (java.lang.reflect.Method method : provider.getClass().getMethods()) {
            if (!"getPlatformStatistics".equals(method.getName()) || method.getParameterTypes().length != 2) continue;
            return method.invoke(provider, new Object[] { null, Boolean.valueOf(includeWorld) });
        }
        return null;
    }

    private static boolean isTrue(Object value) {
        return Boolean.TRUE.equals(value);
    }

    private static Object field(Object target, String name) {
        Class<?> type = target.getClass();
        while (type != null) {
            try {
                java.lang.reflect.Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(target);
            } catch (NoSuchFieldException missing) {
                type = type.getSuperclass();
            } catch (Throwable inaccessible) {
                return null;
            }
        }
        return null;
    }

    private static Object call(Object target, String name) throws Exception {
        if (target == null) return null;
        for (java.lang.reflect.Method method : target.getClass().getMethods()) {
            if (name.equals(method.getName()) && method.getParameterTypes().length == 0) {
                method.setAccessible(true);
                return method.invoke(target);
            }
        }
        return null;
    }

    private static Double number(Object value) {
        return value instanceof Number ? Double.valueOf(((Number) value).doubleValue()) : null;
    }

    private static void writeSnapshot(long now, Map<String, Double> values) throws IOException {
        Path target = output;
        if (target == null) return;
        Files.createDirectories(target.getParent());
        StringBuilder json = new StringBuilder(512);
        json.append("{\"t\":").append(now).append(",\"pid\":").append(pid()).append(",\"values\":{");
        boolean first = true;
        for (Map.Entry<String, Double> entry : values.entrySet()) {
            if (!first) json.append(',');
            first = false;
            json.append('\"').append(entry.getKey()).append("\":");
            Double value = entry.getValue();
            if (value == null || !Double.isFinite(value.doubleValue())) json.append("null");
            else json.append(value.doubleValue());
        }
        json.append("}}\n");
        Path temporary = target.resolveSibling(target.getFileName().toString() + ".tmp");
        byte[] bytes = json.toString().getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream stream = new FileOutputStream(temporary.toFile())) {
            stream.write(bytes);
            stream.getFD().sync();
        }
        try {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static long pid() {
        try {
            String name = ManagementFactory.getRuntimeMXBean().getName();
            int split = name.indexOf('@');
            return Long.parseLong(split < 0 ? name : name.substring(0, split));
        } catch (Throwable ignored) {
            return -1L;
        }
    }

    private static final class GcReading {
        final long at;
        final long count;
        final long pauseMs;
        GcReading(long at, long count, long pauseMs) {
            this.at = at;
            this.count = count;
            this.pauseMs = pauseMs;
        }
    }
}
