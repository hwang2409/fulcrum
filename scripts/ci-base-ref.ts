export function selectBaseRef(candidate: string | undefined, hasHeadParent: boolean): string {
  if (candidate && !/^0+$/.test(candidate)) return candidate;
  return hasHeadParent ? "HEAD^" : "origin/main";
}

if (import.meta.main) {
  const parent = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD^"]);
  console.log(selectBaseRef(process.argv[2], parent.exitCode === 0));
}
