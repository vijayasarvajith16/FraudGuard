import init_env

EXAMPLE = """# comment stays
MONGO_ROOT_USERNAME=fraudguard
MONGO_ROOT_PASSWORD=change-me
RABBITMQ_DEFAULT_PASS=change-me
JWT_SECRET=
JWT_EXPIRES_IN=2h
MLFLOW_TRACKING_USERNAME=
"""


def test_generates_secrets_and_keeps_everything_else():
    text, generated = init_env.render(EXAMPLE)
    values = dict(line.split("=", 1) for line in text.splitlines() if "=" in line and not line.startswith("#"))
    assert generated == ["MONGO_ROOT_PASSWORD", "RABBITMQ_DEFAULT_PASS", "JWT_SECRET"]
    assert values["MONGO_ROOT_USERNAME"] == "fraudguard"
    assert values["JWT_EXPIRES_IN"] == "2h"
    assert values["MLFLOW_TRACKING_USERNAME"] == ""  # optional: stays empty
    assert len(values["JWT_SECRET"]) == 64  # >= 32 bytes, as the services require
    assert len(values["MONGO_ROOT_PASSWORD"]) >= 32
    assert "change-me" not in text
    assert text.startswith("# comment stays\n")


def test_values_differ_between_runs():
    assert init_env.render(EXAMPLE)[0] != init_env.render(EXAMPLE)[0]


def test_never_overwrites_an_existing_env(tmp_path):
    example, out = tmp_path / ".env.example", tmp_path / ".env"
    example.write_text(EXAMPLE, encoding="utf-8")
    out.write_text("KEEP=me\n", encoding="utf-8")
    assert init_env.main(["--example", str(example), "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8") == "KEEP=me\n"
    out.unlink()
    assert init_env.main(["--example", str(example), "--out", str(out)]) == 0
    assert b"\r\n" not in out.read_bytes()
