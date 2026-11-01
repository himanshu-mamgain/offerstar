// Writes the Homebrew formula and Scoop manifest for a release from its
// checksums.txt, ready to copy into the tap and bucket repositories.
//   node scripts/release-manifests.mjs <version> <checksums.txt> <out dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, checksumsFile, out] = process.argv.slice(2);
if (!version || !checksumsFile || !out) throw new Error('usage: release-manifests.mjs <version> <checksums.txt> <out dir>');

const sums = Object.fromEntries(
  readFileSync(checksumsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).reverse()),
);
const url = (asset) => `https://github.com/himanshu-mamgain/offerstar/releases/download/v${version}/${asset}`;
const need = (asset) => sums[asset] ?? (() => { throw new Error(`no checksum for ${asset}`); })();
const desc = 'Agentic job search CLI with Claude Code skills. You approve every application.';

writeFileSync(
  join(out, 'offerstar.rb'),
  `class Offerstar < Formula
  desc "${desc}"
  homepage "https://github.com/himanshu-mamgain/offerstar"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${url('offerstar-macos-arm64')}"
      sha256 "${need('offerstar-macos-arm64')}"
    end
  end
  on_linux do
    on_intel do
      url "${url('offerstar-linux-x64')}"
      sha256 "${need('offerstar-linux-x64')}"
    end
    on_arm do
      url "${url('offerstar-linux-arm64')}"
      sha256 "${need('offerstar-linux-arm64')}"
    end
  end

  def install
    bin.install Dir["offerstar-*"].first => "offerstar"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/offerstar --version")
  end
end
`,
);

writeFileSync(
  join(out, 'offerstar.json'),
  `${JSON.stringify(
    {
      version,
      description: desc,
      homepage: 'https://github.com/himanshu-mamgain/offerstar',
      license: 'MIT',
      architecture: { '64bit': { url: `${url('offerstar-windows-x64.exe')}#/offerstar.exe`, hash: need('offerstar-windows-x64.exe') } },
      bin: 'offerstar.exe',
      checkver: 'github',
      autoupdate: { architecture: { '64bit': { url: 'https://github.com/himanshu-mamgain/offerstar/releases/download/v$version/offerstar-windows-x64.exe#/offerstar.exe' } } },
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote offerstar.rb and offerstar.json to ${out}`);
