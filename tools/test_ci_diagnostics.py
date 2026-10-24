#!/usr/bin/env python3
"""验证失败用例不会被大量 stderr 挤出测试输出。"""
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class DiagnosticsTests(unittest.TestCase):
    def test_failure_details_survive_long_stderr(self):
        source = (ROOT / "x").read_text()
        start = source.index("run_tests_parallel() {")
        end = source.index("\n# 仓库外消费", start)
        with tempfile.TemporaryDirectory() as work:
            script = source[start:end] + '''
dotnet() {
  printf 'failed diagnostic-sentinel\nExpected: true\nActual: false\n'
  for ((i=0; i<100; i++)); do printf 'stderr noise %s\n' "$i"; done
  return 2
}
run_tests_parallel diagnostics libs/Probe/tests/Probe.Tests.fsproj 1
'''
            result = subprocess.run(["bash", "-c", script], cwd=work,
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("failed diagnostic-sentinel", result.stdout)
            self.assertIn("Expected: true", result.stdout)
            self.assertIn("Actual: false", result.stdout)


if __name__ == "__main__":
    unittest.main()
