// Hand-written TeX fixtures for the MathJax-in-Hermes spike. NOT copied from SEP.
// Each entry is a TeX string; entries starting with "D:" are rendered as display math.
// Covers: variables, sub/superscripts, fractions, quantifiers, logic, sets, relations,
// matrices/cases/align, \text, \mathbb/\mathcal/\mathbf, accents, delimiters, macros,
// and a few malformed inputs (expected to error/merror identically).
module.exports = [
  // variables & scripts
  'x', 'p', 'q', 'A', 'x_1', 'x_{12}', 'x^2', 'x_i^2', 'a_{i_j}', 'x^{y^z}', "f'", "f''(x)", "x'",
  'P_n', 'R_{ab}', 'w_0', 'w_{\\alpha}', '\\alpha', '\\beta', '\\gamma', '\\Gamma', '\\delta', '\\Delta',
  '\\varphi', '\\phi', '\\psi', '\\Omega', '\\omega', '\\lambda', '\\mu', '\\pi', '\\sigma', '\\Sigma',
  'a+b', 'a-b', 'a\\cdot b', 'a\\times b', 'a/b', 'a=b', 'a\\neq b', 'a<b', 'a>b', 'a\\leq b', 'a\\geq b',
  'a\\approx b', 'a\\equiv b', 'a\\sim b', 'a\\simeq b', 'a\\cong b', 'a\\propto b', '2+2=4', '10^{3}',
  '\\infty', '\\emptyset', '\\varnothing', '\\partial', '\\nabla', '\\ldots', '\\cdots', '\\vdots', '\\ddots',
  // fractions & roots
  '\\frac{a}{b}', '\\frac{1}{2}', '\\frac{x+1}{x-1}', '\\frac{\\frac{a}{b}}{c}', '\\tfrac{1}{3}', '\\dfrac{p}{q}',
  '\\binom{n}{k}', '\\sqrt{x}', '\\sqrt[3]{x}', '\\sqrt{a^2+b^2}', '\\frac{1}{\\sqrt{2}}', 'n!', '\\binom{n}{k}=\\frac{n!}{k!(n-k)!}',
  'P(A\\mid B)=\\frac{P(A\\cap B)}{P(B)}', 'P(A\\mid B)', 'p(x\\mid y)', '\\Pr(E)', 'E[X]', '\\mathbb{E}[X]',
  // quantifiers & logic
  '\\forall x', '\\exists x', '\\exists! x', '\\forall x\\,\\exists y\\,R(x,y)', '\\forall x(Fx\\to Gx)',
  '\\exists x(Fx\\land Gx)', '\\neg\\exists x\\,Fx', '\\neg p', '\\lnot p', 'p\\land q', 'p\\wedge q', 'p\\lor q', 'p\\vee q',
  'p\\to q', 'p\\rightarrow q', 'p\\leftrightarrow q', 'p\\supset q', 'p\\equiv q', 'p\\Rightarrow q', 'p\\Leftrightarrow q',
  '\\vdash \\phi', '\\Gamma\\vdash\\phi', '\\Gamma\\models\\phi', '\\models\\phi', '\\nvdash\\phi', '\\nvDash\\phi',
  '\\Box p', '\\Diamond p', '\\Box p\\to p', '\\Box(p\\to q)\\to(\\Box p\\to\\Box q)', '\\Diamond p\\leftrightarrow\\neg\\Box\\neg p',
  '\\top', '\\bot', '\\neg\\neg p\\to p', '(p\\land q)\\to p', '((p\\to q)\\land p)\\to q', '\\lnot(p\\lor q)\\equiv(\\lnot p\\land\\lnot q)',
  '\\forall x\\forall y(x=y\\to y=x)', '\\exists x\\forall y(Rxy)', '\\lambda x.\\,x+1', '\\lambda x\\lambda y.\\,x', '\\iota x\\,Fx',
  '\\mathrm{K}', '\\mathbf{S5}', '\\mathsf{T}', '\\mathrm{S4}', '\\mathsf{GL}', '\\mathrm{Th}(M)', '\\mathcal{M}\\models\\phi', '\\mathfrak{A}\\models\\phi[a]',
  // sets
  'x\\in A', 'x\\notin A', 'A\\subset B', 'A\\subseteq B', 'A\\supseteq B', 'A\\subsetneq B', 'A\\cup B', 'A\\cap B', 'A\\setminus B',
  'A^{c}', '\\overline{A}', '\\bar{x}', '\\hat{x}', '\\tilde{x}', '\\vec{v}', '\\dot{x}', '\\ddot{x}', '\\underline{x}', '\\widehat{abc}',
  '\\{a,b,c\\}', '\\{x\\mid x>0\\}', '\\{x : Fx\\}', '\\{\\}', '|A|', '\\|x\\|', '\\lvert x\\rvert', '\\lVert x\\rVert', '\\langle a,b\\rangle',
  '\\lceil x\\rceil', '\\lfloor x\\rfloor', '\\mathcal{P}(A)', '2^{A}', 'A\\times B', 'A\\triangle B', 'f\\colon A\\to B', 'f:A\\rightarrow B', 'f\\circ g',
  'f^{-1}', 'f\\restriction A', 'f\\upharpoonright A', 'a\\mapsto b', 'x\\mapsto x^2',
  // blackboard etc.
  '\\mathbb{N}', '\\mathbb{Z}', '\\mathbb{Q}', '\\mathbb{R}', '\\mathbb{C}', '\\mathbb{N}\\subset\\mathbb{Z}\\subset\\mathbb{Q}', '\\mathcal{A}', '\\mathcal{L}',
  '\\mathcal{F}', '\\mathbf{x}', '\\boldsymbol{\\alpha}', '\\mathfrak{p}', '\\mathscr{F}', '\\mathbb{1}', '\\aleph_0', '\\aleph_1', '2^{\\aleph_0}', '\\omega_1', '\\beth_1',
  // big operators
  '\\sum_{i=1}^{n} i', '\\sum_{i=1}^{n}x_i', '\\prod_{i=1}^{n}x_i', '\\int_0^1 x\\,dx', '\\int_{-\\infty}^{\\infty}e^{-x^2}dx', '\\oint f\\,dz',
  '\\bigcup_{i\\in I}A_i', '\\bigcap_{i\\in I}A_i', '\\lim_{n\\to\\infty}a_n', '\\max_{x}f(x)', '\\min_{x}f(x)', '\\sup S', '\\inf S',
  '\\bigwedge_{i}\\phi_i', '\\bigvee_{i}\\phi_i', '\\log_2 n', '\\ln x', '\\sin\\theta', '\\cos^2\\theta+\\sin^2\\theta=1', '\\exp(x)', '\\det A', '\\dim V',
  '\\arg\\max_x f(x)', '\\operatorname{rank}(M)', '\\gcd(a,b)', 'a\\bmod b', 'a\\equiv b\\pmod{n}',
  // text
  '\\text{if }x>0', 'x\\text{ and }y', '\\text{All men are mortal}', '\\text{Socrates is a man}', 'x\\ \\text{is red}', '\\mbox{hello}', '\\textit{a}', '\\textbf{b}',
  '\\mathrm{true}', '\\mathrm{false}', '\\text{ iff }', 'P\\text{ iff }Q', 'x\\quad y', 'x\\qquad y', 'x\\,y', 'x\\;y', 'x\\!y', 'x~y',
  // delimiters
  '\\left(\\frac{a}{b}\\right)', '\\left[x\\right]', '\\left\\{ a \\right\\}', '\\left|x\\right|', '\\left\\langle a\\right\\rangle', '\\bigl(x\\bigr)', '\\Bigl[x\\Bigr]', '\\big|x\\big|',
  '\\left.\\frac{df}{dx}\\right|_{x=0}', '\\left(\\sum_{i=1}^n x_i\\right)^2',
  // arrows & misc
  '\\to', '\\longrightarrow', '\\Longrightarrow', '\\mapsto', '\\hookrightarrow', '\\twoheadrightarrow', '\\uparrow', '\\downarrow', '\\leftarrow', '\\leftrightarrow',
  '\\xrightarrow{f}', '\\xrightarrow[g]{f}', '\\overset{def}{=}', '\\stackrel{\\text{def}}{=}', '\\underbrace{a+b}_{n}', '\\overbrace{a+b}^{n}', '\\prec', '\\preceq', '\\succ', '\\sqsubseteq',
  '\\perp', '\\parallel', '\\angle ABC', '\\triangle ABC', '\\therefore', '\\because', '\\dagger', '\\ddagger', '\\star', '\\ast', '\\circ', '\\bullet', '\\oplus', '\\otimes', '\\odot',
  // macros & packages
  '\\newcommand{\\R}{\\mathbb{R}}\\R^n', '\\def\\foo{x}\\foo', '\\require{cancel}\\cancel{x}', '\\bcancel{x}', '\\color{red}{x}', '\\textcolor{blue}{y}', '\\boxed{x=1}', '\\not\\equiv', '\\not\\in', '\\not=',
  '\\operatorname{Con}(T)', '\\DeclareMathOperator{\\Th}{Th}\\Th(T)', '\\mathop{\\mathrm{lim\\,sup}}', '\\mathbin{\\#}', '\\mathrel{R}',
  // display / environments (prefixed D:)
  'D:\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', 'D:\\int_a^b f(x)\\,dx', 'D:\\lim_{x\\to 0}\\frac{\\sin x}{x}=1', 'D:\\prod_{i=1}^{n}\\left(1+x_i\\right)',
  'D:\\bigcup_{i\\in I}A_i', 'D:\\forall x\\,\\exists y\\,(x<y)', 'D:\\frac{\\partial f}{\\partial x}', 'D:e^{i\\pi}+1=0',
  'D:\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', 'D:\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}', 'D:\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}', 'D:\\begin{matrix}1&2\\\\3&4\\end{matrix}',
  'D:\\begin{cases}1&\\text{if }x>0\\\\0&\\text{otherwise}\\end{cases}', 'D:f(x)=\\begin{cases}x&x\\ge0\\\\-x&x<0\\end{cases}',
  'D:\\begin{array}{cc}a&b\\\\c&d\\end{array}', 'D:\\begin{array}{l|r}x&1\\\\\\hline y&2\\end{array}', 'D:\\begin{aligned}a&=b+c\\\\&=d\\end{aligned}',
  'D:\\begin{align}a&=b\\\\c&=d\\end{align}', 'D:\\begin{gather}a=b\\\\c=d\\end{gather}', 'D:\\begin{split}a&=b\\\\&=c\\end{split}', 'D:\\begin{equation}x=y\\end{equation}',
  'D:\\begin{array}{c}\\phi\\\\\\hline\\psi\\end{array}', 'D:\\frac{\\phi\\quad\\psi}{\\phi\\land\\psi}', 'D:\\cfrac{1}{1+\\cfrac{1}{x}}', 'D:\\sqrt{\\frac{a}{b}}', 'D:\\sum_{n=0}^{\\infty}\\frac{x^n}{n!}=e^x',
  'D:\\mathbb{P}(A)=\\sum_{\\omega\\in A}\\mathbb{P}(\\{\\omega\\})', 'D:\\Gamma\\vdash\\phi\\quad\\Longleftrightarrow\\quad\\Gamma\\models\\phi', 'D:\\Box(\\Box p\\to p)\\to\\Box p',
  'D:\\underset{x}{\\arg\\min}\\,f(x)', 'D:\\begin{pmatrix}1&2&3\\\\4&5&6\\\\7&8&9\\end{pmatrix}', 'D:x_1,\\ldots,x_n', 'D:\\left\\{\\begin{array}{ll}a&b\\\\c&d\\end{array}\\right.',
  // malformed / edge (both engines should agree on the error)
  '\\frac{a}', '\\undefinedmacro', 'x^', '{', '}', '\\begin{foo}x\\end{foo}', '', ' ', '\\text{unclosed', '€10', 'x_1_2', 'x^1^2', '\\left( x', '$x$', 'a & b',
  // unicode / non-ASCII in text and math
  '\\text{é ü ñ}', 'é', '∀x', 'α+β', '\\text{日本語}', '\\mathrm{\\acute{e}}', '\\text{“quoted”}', '\\text{a–b}',
];
