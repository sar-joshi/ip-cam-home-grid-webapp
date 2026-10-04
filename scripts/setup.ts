import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { privateSetup } from "./private-setup.ts";

process.umask(0o077);
async function hidden(prompt: string): Promise<string> {
  if (!stdin.isTTY)
    throw new Error("Use an interactive terminal for private setup");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", data);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const data = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          finish();
          reject(new Error("Setup cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", data);
  });
}
try {
  if (existsSync("gateway.env"))
    throw new Error(
      "gateway.env exists. Keep it and use the password reset command described in the guide.",
    );
  console.log(
    "HomeGrid private setup. Passwords are entered locally and are never printed.",
  );
  const rl = createInterface({ input: stdin, output: stdout });
  const appOrigin =
    (
      await rl.question("Viewer origin [https://homegrid.thepixelscout.com]: ")
    ).trim() || "https://homegrid.thepixelscout.com";
  const gatewayUrl =
    (
      await rl.question(
        "Gateway origin [https://homegrid-gateway.thepixelscout.com]: ",
      )
    ).trim() || "https://homegrid-gateway.thepixelscout.com";
  const lanIp = (await rl.question("This computer's LAN IP: ")).trim();
  const nvrHost = (await rl.question("NVR IP: ")).trim();
  const nvrUser = (await rl.question("NVR read-only username: ")).trim();
  rl.close();
  const nvrPassword = await hidden("NVR password (hidden): ");
  const password = await hidden(
    "New household password, 12–128 characters (hidden): ",
  );
  const confirmation = await hidden("Confirm household password (hidden): ");
  await privateSetup({
    appOrigin,
    gatewayUrl,
    lanIp,
    nvrHost,
    nvrUser,
    nvrPassword,
    password,
    confirmation,
  });
  console.log(
    "Setup complete. Private configuration is saved in gateway.env and apps/web/.env.local. Nothing was sent online.",
  );
  console.log(
    "Run npm run gateway. Upload only the three frontend variables to Vercel production using the deployment helper.",
  );
} catch (error) {
  // Errors here are authored setup messages; authentication/NVR failures never include input values.
  console.error(
    error instanceof Error && error.message.startsWith("gateway.env")
      ? error.message
      : "Setup did not finish. Check the input, existing state, and password requirements. No passwords were printed.",
  );
  process.exitCode = 1;
}
