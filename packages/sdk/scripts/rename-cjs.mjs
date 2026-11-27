import fs from "node:fs";
import path from "node:path";

const cjsDir = path.resolve("dist/cjs");
for (const entry of fs.readdirSync(cjsDir)) {
  if (entry.endsWith(".js")) {
    const fullPath = path.join(cjsDir, entry);
    let content = fs.readFileSync(fullPath, "utf8");
    content = content.replace(/require\("\.\/([^"]+?)\.js"\)/g, 'require("./$1.cjs")');
    content = content.replace(/require\("\.\/([^"]+?)"\)/g, (m, p1) =>
      p1.endsWith(".cjs") ? m : `require("./${p1}.cjs")`,
    );
    fs.writeFileSync(fullPath.replace(/\.js$/, ".cjs"), content);
    fs.unlinkSync(fullPath);
  }
}

