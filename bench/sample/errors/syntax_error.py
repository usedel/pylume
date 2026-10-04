"""语法错误样例（SyntaxError 单行 File 格式，S1-T05 第 6 项）。

Python 语法错误的 traceback 是单行格式：
    File "syntax_error.py", line 6
        print("hello"
              ^
SyntaxError: '(' was never closed
验证点：单行 File 帧同样可点击跳转。
"""
# 测试一下





def add(a, b):
    return a+b




def main():
    n = 1
    v = 2
    f = add(n,1)
    

def greet(name: str) -> str:
    return f"hello, {name}"


print("hello"  # ← 语法错误：括号未闭合（line 16）
