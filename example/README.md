# sema-core 跨语言集成

通过 WebSocket 桥接集成 sema-core 的多语言示例项目，目前提供 C# 和 Java 两个客户端实现。

## 架构

**WebSocket 方式（sema-bridge）：**
```
客户端应用 (C# / Java / Python)
    ↕ WebSocket (ws://localhost:3765)
Node.js 桥接服务 (sema-bridge)
    ↕ 内部调用
sema-core (npm 包)
```

**gRPC 方式（sema-grpc）：**
```
客户端应用 (C# / Java / Python / ...)
    ↕ gRPC 双向流 (grpc://localhost:3766)
Node.js gRPC 服务 (sema-grpc)
    ↕ 内部调用
sema-core (npm 包)
```

## 项目结构

```
sema-csharp-demo/
├── sema-bridge/              # Node.js WebSocket 桥接服务
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts             # WebSocket 服务器入口
│       ├── session.ts            # 会话管理
│       └── protocol.ts           # 协议类型定义
├── sema-grpc/                # Node.js gRPC 桥接服务
│   ├── package.json
│   ├── tsconfig.json
│   ├── proto/
│   │   └── sema.proto            # Protobuf 协议定义
│   └── src/
│       ├── server.ts             # gRPC 服务器入口
│       └── session.ts            # 会话管理
├── sema-csharp-demo/         # C# 客户端
│   ├── SemaDemo.csproj
│   ├── Protocol.cs               # 协议模型
│   ├── SemaCoreClient.cs         # WebSocket 客户端封装
│   └── Program.cs                # 示例主程序
├── sema-java-demo/           # Java 客户端
│   ├── pom.xml
│   └── src/main/java/com/semademo/
│       ├── SemaCoreConfig.java   # 配置 POJO
│       ├── BridgeCommand.java    # 指令帧模型
│       ├── BridgeEvent.java      # 事件帧模型
│       ├── SemaCoreClient.java   # WebSocket 客户端封装
│       └── Main.java             # 示例主程序
└── sema-python-demo/         # Python 客户端
    ├── requirements.txt
    ├── sema_core_config.py   # 配置 dataclass
    ├── bridge_command.py     # 指令帧模型
    ├── bridge_event.py       # 事件帧模型
    ├── sema_core_client.py   # WebSocket 客户端封装
    └── main.py               # 示例主程序
```

## 环境安装

### 安装 Node.js 和 .NET SDK（C# 客户端）

验证安装：

```bash
dotnet --version
node --version
npm --version
```

### 安装 Node.js 和 JDK 17+（Java 客户端）

验证安装：

```bash
java --version
mvn --version
node --version
npm --version
```

### 安装 Node.js 和 Python 3.10+（Python 客户端）

验证安装：

```bash
python3 --version
node --version
npm --version
```

## 启动步骤

### 1. 启动桥接服务

**WebSocket 方式（sema-bridge）：**

```bash
cd sema-bridge
npm install
npm run build
npm start
# 或开发模式：npx ts-node src/server.ts
```

环境变量：
- `SEMA_BRIDGE_PORT`：端口，默认 `3765`
- `SEMA_WORKING_DIR`：工作目录，默认当前目录

### 2. 运行 C# Demo

修改 workingDir 和 apiKey：

```csharp
// sema-csharp-demo/Program.cs

WorkingDir = "/path/to/your/project", // Target repository path for the Agent to operate on

apiKey = "sk-your-api-key", // Replace with your API Key
```
更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)

运行：

```bash
cd sema-csharp-demo
dotnet run
```

### 3. 运行 Java Demo

修改 workingDir 和 apiKey：

```java
// sema-java-demo/src/main/java/com/semademo/Main.java

.workingDir("/path/to/your/project") // Target repository path for the Agent to operate on

apiKey = "sk-your-api-key", // Replace with your API Key
```
更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)

运行：

```bash
cd sema-java-demo

# 打包（含所有依赖的 fat-jar）
mvn package -q

# 运行
java -jar target/sema-java-demo-1.0-SNAPSHOT-jar-with-dependencies.jar
```

或直接通过 Maven 运行（无需打包）：

```bash
cd sema-java-demo
mvn compile exec:java -Dexec.mainClass=com.semademo.Main
```

### 4. 运行 Python Demo

修改 working_dir 和 apiKey：

```python
# sema-python-demo/main.py

working_dir="/path/to/your/project"  # Target repository path for the Agent to operate on

"apiKey": "sk-your-api-key",  # Replace with your API Key
```
更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)

运行：

```bash
cd sema-python-demo

# 安装依赖
pip install -r requirements.txt

# 运行
python main.py
```

## 客户端实现对比

| 特性 | C# | Java | Python |
|---|---|---|---|
| WebSocket | `ClientWebSocket` | OkHttp `WebSocket` | `websockets` |
| JSON | Newtonsoft.Json | Jackson | 内置 `json` |
| 异步 | `Task` / `async-await` | `CompletableFuture` | `asyncio` |
| 信号量 | `SemaphoreSlim` | `Semaphore` | `asyncio.Event` |
| 事件回调 | `Action<JToken?>` | `Consumer<JsonNode>` | `Callable` |
| 构建工具 | `dotnet` | Maven | pip |
