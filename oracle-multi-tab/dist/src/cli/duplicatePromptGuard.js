import chalk from "chalk";
export async function shouldBlockDuplicatePrompt({ prompt, force, sessionStore, log = console.log, }) {
    if (force)
        return false;
    const normalized = prompt?.trim();
    if (!normalized)
        return false;
    const running = (await sessionStore.listSessions()).filter((entry) => entry.status === "running");
    const duplicate = running.find((entry) => (entry.options?.prompt?.trim?.() ?? "") === normalized);
    if (!duplicate)
        return false;
    log(chalk.yellow(`A session with the same prompt is already running (${duplicate.id}). Reattach with "oracle session ${duplicate.id}" or rerun with --force to start another run.`));
    return true;
}
