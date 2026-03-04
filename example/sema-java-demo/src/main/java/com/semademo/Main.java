package com.semademo;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Scanner;
import java.util.concurrent.*;

public class Main {

    static String gray(String s)  { return "\u001b[90m" + s + "\u001b[0m"; }
    static String blue(String s)  { return "\u001b[34m" + s + "\u001b[0m"; }
    static String green(String s) { return "\u001b[32m" + s + "\u001b[0m"; }

    public static void main(String[] args) throws Exception {

        // ── 配置 ─────────────────────────────────────────────────────────
        final String BRIDGE_URL = "ws://localhost:3765";

        System.out.println("=== Sema Java Demo ===");
        System.out.println("Connecting to sema-bridge at " + BRIDGE_URL + "...\n");

        Scanner scanner = new Scanner(System.in);

        try (SemaCoreClient client = new SemaCoreClient()) {

            // ── 日志事件（灰色输出，对应 quickstart.mjs events 数组）────────
            for (String e : new String[]{
                    "tool:execution:start", "tool:execution:complete", "tool:execution:error", "tool:permission:request",
                    "task:agent:start", "task:agent:end", "todos:update", "session:interrupted"
            }) {
                final String eName = e;
                client.on(eName, data ->
                        System.out.println(gray(eName + "|" + (data != null ? data.toString() : ""))));
            }

            // ── 流式输出 ──────────────────────────────────────────────────
            client.on("message:text:chunk", data -> {
                if (data != null && data.has("delta"))
                    System.out.print(data.get("delta").asText());
            });

            client.on("message:complete", data -> System.out.println());

            // ── 权限交互（覆盖日志处理器，追加用户确认逻辑）─────────────────
            client.on("tool:permission:request", data -> {
                String toolName = data != null && data.has("toolName") ? data.get("toolName").asText() : "";
                System.out.print(blue("👤 权限响应 (y=agree / a=allow / n=refuse): "));
                String answer = scanner.nextLine().trim();
                String selected = switch (answer) {
                    case "a" -> "allow";
                    case "n" -> "refuse";
                    default  -> "agree";
                };
                client.respondToPermissionAsync(toolName, selected);
            });

            // ── 问答请求 ──────────────────────────────────────────────────
            client.on("ask:question:request", data -> {
                String id       = data != null && data.has("id")       ? data.get("id").asText()       : "";
                String question = data != null && data.has("question") ? data.get("question").asText() : "";
                System.out.println("[Question] " + question);
                System.out.print("Your answer: ");
                client.respondToQuestionAsync(id, scanner.nextLine());
            });

            // ── Plan 退出请求 ─────────────────────────────────────────────
            client.on("plan:exit:request", data -> {
                System.out.println("[Plan] Exit plan mode — approving");
                String id = data != null && data.has("id") ? data.get("id").asText() : "";
                client.respondToPlanExitAsync(id, true);
            });

            // ── 连接 ──────────────────────────────────────────────────────
            try {
                client.connectAsync(BRIDGE_URL).get(10, TimeUnit.SECONDS);
                System.out.println("Connected!\n");
            } catch (Exception ex) {
                System.err.println("Failed to connect: " + ex.getMessage());
                System.err.println("Make sure sema-bridge is running: cd sema-bridge && npm start");
                return;
            }

            // ── 核心配置（对应 quickstart.mjs 的 new SemaCore({...}) 选项）──────
            client.initCoreAsync(SemaCoreConfig.builder()
                    .workingDir("/path/to/your/project") // Target repository path for the Agent to operate on
                    .logLevel("none")
                    .thinking(false)
                    // 按需启用其他选项：
                    // .skipFileEditPermission(true)
                    // .skipBashExecPermission(true)
                    // .agentMode("Plan")
                    // .systemPrompt("你是一个 Java 专家")
                    .build()
            ).get(15, TimeUnit.SECONDS);

            // ── 配置模型（对应 quickstart.mjs 的 addModel + applyTaskModel）──────
            Map<String, Object> modelConfig = new LinkedHashMap<>();
            modelConfig.put("provider",      "deepseek");
            modelConfig.put("modelName",     "deepseek-chat");
            modelConfig.put("baseURL",       "https://api.deepseek.com/anthropic");
            modelConfig.put("apiKey",        "sk-your-api-key");  // Replace with your API Key
            modelConfig.put("maxTokens",     8192);
            modelConfig.put("contextLength", 128000);

            client.addModelAsync(modelConfig, false).get(15, TimeUnit.SECONDS);
            String modelId = "deepseek-chat[deepseek]";
            client.applyTaskModelAsync(modelId, modelId).get(15, TimeUnit.SECONDS);
            System.out.println("Model configured: " + modelId + "\n");

            // ── 创建会话，等待 session:ready ──────────────────────────────
            CompletableFuture<String> sessionReadyFuture = new CompletableFuture<>();
            client.once("session:ready", data -> {
                String sid = data != null && data.has("sessionId") ? data.get("sessionId").asText() : "";
                sessionReadyFuture.complete(sid);
            });

            client.createSessionAsync().get(15, TimeUnit.SECONDS);
            String sessionId = sessionReadyFuture.get(30, TimeUnit.SECONDS);
            System.out.println("Session ready: " + sessionId + "\n");

            // ── Ctrl+C 中断 ───────────────────────────────────────────────
            boolean[] interrupted = {false};
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                if (!interrupted[0]) {
                    interrupted[0] = true;
                    System.out.println("\n⚠️  中断会话...");
                    try { client.interruptAsync().get(5, TimeUnit.SECONDS); } catch (Exception ignored) {}
                }
            }));

            // ── 对话循环（对应 quickstart.mjs 的 Promise + state:update 模式）─
            CompletableFuture<Void> conversationFuture = new CompletableFuture<>();
            Semaphore idleSignal = new Semaphore(0);

            // 对应 quickstart.mjs: core.once('session:error', reject)
            client.once("session:error", data -> {
                String msg = data != null && data.has("message") ? data.get("message").asText() : "";
                conversationFuture.completeExceptionally(new RuntimeException(msg));
            });

            // 当 state:update 变为 idle 时释放信号
            client.on("state:update", data -> {
                if (data != null && data.has("state")
                        && "idle".equals(data.get("state").asText())
                        && idleSignal.availablePermits() == 0) {
                    idleSignal.release();
                }
            });

            // 对话辅助方法
            ExecutorService executor = Executors.newSingleThreadExecutor();
            executor.submit(() -> {
                try {
                    System.out.print(blue("👤 消息 (exit退出): "));
                    String input = scanner.nextLine().trim();
                    if ("exit".equals(input) || "quit".equals(input)) {
                        conversationFuture.complete(null);
                        return null;
                    }
                    if (!input.isEmpty()) {
                        System.out.print(green("\n🤖 AI: "));
                        client.sendUserInputAsync(input).get();
                        idleSignal.acquire();
                        Thread.sleep(100);
                    }

                    // 后续轮次由 state:update idle 驱动
                    while (!conversationFuture.isDone()) {
                        System.out.print(blue("\n👤 消息 (exit退出): "));
                        input = scanner.nextLine().trim();
                        if ("exit".equals(input) || "quit".equals(input)) {
                            conversationFuture.complete(null);
                            return null;
                        }
                        if (!input.isEmpty()) {
                            System.out.print(green("\n🤖 AI: "));
                            client.sendUserInputAsync(input).get();
                            idleSignal.acquire();
                            Thread.sleep(100);
                        }
                    }
                } catch (Exception ex) {
                    conversationFuture.completeExceptionally(ex);
                }
                return null;
            });

            try {
                conversationFuture.get();
            } catch (ExecutionException ex) {
                System.err.println("[Error] " + ex.getCause().getMessage());
            }

            executor.shutdown();
        }

        System.out.println("\n=== 会话结束 ===");
    }
}
