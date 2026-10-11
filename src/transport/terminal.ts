import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { PennyService } from "../application/penny.js";

export async function runTerminal(service: PennyService): Promise<void> {
  const prompt = createInterface({ input: stdin, output: stdout });
  console.log(
    "Penny terminal diagnostics (the judged product interface is iMessage). Type 'exit' to stop.",
  );
  let sequence = 0;
  while (true) {
    const text = await prompt.question("you> ");
    if (text.trim().toLowerCase() === "exit") break;
    const reply = await service.handle({
      id: `terminal-${++sequence}`,
      photonUserId: "terminal-user",
      photonSpaceId: "terminal-space",
      text,
    });
    if (reply.text) console.log(`penny> ${reply.text}`);
  }
  prompt.close();
}
