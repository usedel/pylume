import { describe, expect, it } from "vitest";
import { ensurePyExtension, relativePathOrName, relativePathRaw, stripPyExtension } from "../util";

describe("ensurePyExtension（新建 Python 文件扩展名补齐）", () => {
  it("无扩展名补 .py", () => {
    expect(ensurePyExtension("foo")).toBe("foo.py");
    expect(ensurePyExtension("mod")).toBe("mod.py");
  });

  it(".py 保持不变", () => {
    expect(ensurePyExtension("foo.py")).toBe("foo.py");
  });

  it(".pyw 保持不变", () => {
    expect(ensurePyExtension("foo.pyw")).toBe("foo.pyw");
  });

  it("相对路径补最末段扩展名", () => {
    expect(ensurePyExtension("pkg/mod")).toBe("pkg/mod.py");
  });
});

describe("stripPyExtension（建包名归一化）", () => {
  it("无扩展名不变", () => {
    expect(stripPyExtension("pkg")).toBe("pkg");
  });

  it("剥离 .py 后缀", () => {
    expect(stripPyExtension("pkg.py")).toBe("pkg");
  });

  it("剥离 .pyw 后缀", () => {
    expect(stripPyExtension("pkg.pyw")).toBe("pkg");
  });

  it("相对路径剥离最末段后缀", () => {
    expect(stripPyExtension("sub/pkg.py")).toBe("sub/pkg");
  });
});

describe("relativePathRaw（复制相对路径，保留原样）", () => {
  it("Windows 反斜杠原样保留，且不改大小写", () => {
    expect(relativePathRaw("D:\\code\\proj", "D:\\code\\proj\\src\\Foo.py")).toBe("src\\Foo.py");
  });

  it("正斜杠原样保留", () => {
    expect(relativePathRaw("/home/u/proj", "/home/u/proj/src/foo.py")).toBe("src/foo.py");
  });

  it("盘符/目录大小写不一致仍能匹配（前缀判断归一化）", () => {
    expect(relativePathRaw("d:\\code\\proj", "D:\\Code\\Proj\\src\\Foo.py")).toBe("src\\Foo.py");
  });

  it("工作区根带尾部分隔符也能匹配", () => {
    expect(relativePathRaw("D:\\code\\proj\\", "D:\\code\\proj\\src\\Foo.py")).toBe("src\\Foo.py");
  });

  it("前缀陷阱：D:/proj2 不算 D:/proj 之内", () => {
    expect(relativePathRaw("D:/proj", "D:/proj2/x.py")).toBeNull();
  });

  it("不在工作区内返回 null", () => {
    expect(relativePathRaw("D:\\code\\proj", "C:\\other\\x.py")).toBeNull();
  });

  it("root 为空返回 null", () => {
    expect(relativePathRaw("", "D:\\code\\proj\\x.py")).toBeNull();
  });
});

describe("relativePathOrName（复制相对路径：无工作区/越界回退文件名）", () => {
  it("工作区内取相对路径，保留原样", () => {
    expect(relativePathOrName("D:\\code\\proj", "D:\\code\\proj\\src\\Foo.py")).toBe("src\\Foo.py");
  });

  it("无工作区（null）回退为文件名", () => {
    expect(relativePathOrName(null, "D:\\code\\proj\\src\\Foo.py")).toBe("Foo.py");
  });

  it("空字符串工作区回退为文件名", () => {
    expect(relativePathOrName("", "D:\\code\\proj\\src\\Foo.py")).toBe("Foo.py");
  });

  it("文件不在工作区内回退为文件名", () => {
    expect(relativePathOrName("D:\\code\\proj", "C:\\other\\x.py")).toBe("x.py");
  });
});