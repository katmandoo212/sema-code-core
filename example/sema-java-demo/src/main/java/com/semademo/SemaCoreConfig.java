package com.semademo;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * SemaCore 初始化配置，对应 sema-core 的 SemaCoreConfig 接口
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class SemaCoreConfig {

    /** Agent 操作的目标代码仓库绝对路径 */
    @JsonProperty("workingDir")
    public String workingDir;

    /** 日志级别，默认 info */
    @JsonProperty("logLevel")
    public String logLevel;

    /** 流式输出 AI 响应，默认 true */
    @JsonProperty("stream")
    public Boolean stream;

    /** 输出思考过程，默认 false */
    @JsonProperty("thinking")
    public Boolean thinking;

    /** 系统提示词 */
    @JsonProperty("systemPrompt")
    public String systemPrompt;

    /** 用户自定义规则 */
    @JsonProperty("customRules")
    public String customRules;

    /** 跳过文件编辑权限检查，默认 false */
    @JsonProperty("skipFileEditPermission")
    public Boolean skipFileEditPermission;

    /** 跳过 Bash 执行权限检查，默认 false */
    @JsonProperty("skipBashExecPermission")
    public Boolean skipBashExecPermission;

    /** 跳过 Skill 权限检查，默认 false */
    @JsonProperty("skipSkillPermission")
    public Boolean skipSkillPermission;

    /** 跳过 MCP 工具权限检查，默认 false */
    @JsonProperty("skipMCPToolPermission")
    public Boolean skipMCPToolPermission;

    /** 开启 LLM 缓存，默认 false，建议只在重复测试时使用 */
    @JsonProperty("enableLLMCache")
    public Boolean enableLLMCache;

    /** 限定使用的工具列表，null 表示使用所有工具 */
    @JsonProperty("useTools")
    public String[] useTools;

    /** Agent 模式：Agent 或 Plan，默认 Agent */
    @JsonProperty("agentMode")
    public String agentMode;

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private final SemaCoreConfig c = new SemaCoreConfig();

        public Builder workingDir(String v)              { c.workingDir = v;              return this; }
        public Builder logLevel(String v)                { c.logLevel = v;                return this; }
        public Builder stream(Boolean v)                 { c.stream = v;                  return this; }
        public Builder thinking(Boolean v)               { c.thinking = v;                return this; }
        public Builder systemPrompt(String v)            { c.systemPrompt = v;            return this; }
        public Builder customRules(String v)             { c.customRules = v;             return this; }
        public Builder skipFileEditPermission(Boolean v) { c.skipFileEditPermission = v;  return this; }
        public Builder skipBashExecPermission(Boolean v) { c.skipBashExecPermission = v;  return this; }
        public Builder skipSkillPermission(Boolean v)    { c.skipSkillPermission = v;     return this; }
        public Builder skipMCPToolPermission(Boolean v)  { c.skipMCPToolPermission = v;   return this; }
        public Builder enableLLMCache(Boolean v)         { c.enableLLMCache = v;          return this; }
        public Builder useTools(String... v)             { c.useTools = v;                return this; }
        public Builder agentMode(String v)               { c.agentMode = v;               return this; }

        public SemaCoreConfig build() { return c; }
    }
}
