import { CONVERSATION_TURN_SELECTOR } from "./constants.js";
export function buildConversationDebugExpression() {
    return `(() => {
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    return turns.map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText?.slice(0, 200),
      testid: node.getAttribute('data-testid'),
    }));
  })()`;
}
export async function logConversationSnapshot(Runtime, logger) {
    const expression = buildConversationDebugExpression();
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    if (Array.isArray(result.value)) {
        const recent = result.value.slice(-3);
        logger(`Conversation snapshot: ${JSON.stringify(recent)}`);
    }
}
export async function logDomFailure(Runtime, logger, context) {
    if (!logger?.verbose) {
        return;
    }
    try {
        const entry = `Browser automation failure (${context}); capturing DOM snapshot for debugging...`;
        logger(entry);
        if (logger.sessionLog && logger.sessionLog !== logger) {
            logger.sessionLog(entry);
        }
        await logConversationSnapshot(Runtime, logger);
    }
    catch {
        // ignore snapshot failures
    }
}
