import net from "node:net";

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<{ delivered: boolean; messageId: string }>;
}

/**
 * Lightweight zero-dependency SMTP client (RFC 5321 plain/Mailpit compatible) for transactional verification,
 * password reset, and organization invitation emails.
 */
export class SmtpEmailTransport implements EmailTransport {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  async send(message: EmailMessage): Promise<{ delivered: boolean; messageId: string }> {
    const messageId = `<${Date.now()}.${Math.random().toString(16).slice(2)}@onelinebooking.local>`;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(5_000);
      let buffer = "";
      let step = 0;

      const commands = [
        `EHLO localhost\r\n`,
        `MAIL FROM:<${message.from}>\r\n`,
        `RCPT TO:<${message.to}>\r\n`,
        `DATA\r\n`,
        [
          `From: ${message.from}`,
          `To: ${message.to}`,
          `Subject: ${message.subject}`,
          `Message-ID: ${messageId}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          message.text.replace(/\r?\n\./g, "\r\n.."),
          `.`,
        ].join("\r\n") + "\r\n",
        `QUIT\r\n`,
      ];

      socket.on("timeout", () => {
        socket.destroy(new Error("SMTP socket timeout"));
      });
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const code = Number(line.slice(0, 3));
          const isFinalLine = line[3] === " ";
          if (!isFinalLine) continue;
          if (code >= 400) {
            socket.destroy(new Error(`SMTP error ${line}`));
            return;
          }
          if (step < commands.length) {
            socket.write(commands[step]!);
            step += 1;
          } else {
            socket.end();
            resolve();
          }
        }
      });
    });
    return { delivered: true, messageId };
  }
}

