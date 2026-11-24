# structured-questions · DSH 结构化提问

**风险：medium**

## 功能

把模型提出的选项、多选和自定义文本问题映射到聊天，校验答案并解决 pending 请求。

## 入口

- `src/questions.ts` — `QuestionBroker.ask()`, `answer()`, `cancel()`
- `src/agent.ts` — `SessionRuntime.answerQuestions()`
- `media/webview.js` — `showQuestions()`

## 调用链

```
SDK onUserQuestion → QuestionBroker.ask → Webview questions → answerQuestions → resolve 或 Host 关闭时 cancel
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `.question, .question-title` | `showQuestions` |

## 消息

- **Webview → 扩展**: `answerQuestions`
- **扩展 → Webview**: `questions`, `error`

## 约束

1. requestId 必须匹配当前 pending 问题；重复/过期答案不解决新请求
2. 答案数量、选项和多选约束需再次校验
3. Host 关闭必须 resolve cancelled，不能留下悬空 Promise

## 测试

`question-probe`
