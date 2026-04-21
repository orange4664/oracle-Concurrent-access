import clipboard from "clipboardy";
export async function copyToClipboard(text) {
    try {
        await clipboard.write(text);
        return { success: true, command: "clipboardy" };
    }
    catch (error) {
        return { success: false, error };
    }
}
