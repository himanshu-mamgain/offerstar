// The spellings recruiters and postings use for each skill, so "NodeJS" in a
// posting and "node.js" in a block count as the same thing. Grouped by the
// role packs in the plan; extend a group rather than adding near-duplicates.
const GROUPS: Record<string, Record<string, string[]>> = {
  javascript: {
    'javascript': ['js', 'es6', 'ecmascript'],
    'typescript': [],
    'node.js': ['node', 'nodejs', 'node js'],
    'express.js': ['expressjs'],
    'nestjs': ['nest.js', 'nest js'],
    'react': ['react.js', 'reactjs'],
    'next.js': ['nextjs', 'next js'],
    'angular': ['angularjs', 'angular.js'],
    'vue': ['vue.js', 'vuejs'],
    'redux': [],
    'graphql': [],
    'rest api': ['rest apis', 'restful', 'restful api', 'restful apis'],
    'websockets': ['websocket', 'socket.io'],
    'html': ['html5'],
    'css': ['css3', 'tailwind', 'tailwindcss', 'sass', 'scss'],
  },
  java: {
    'java': ['core java', 'java 8', 'java 11', 'java 17', 'java 21'],
    'spring boot': ['springboot', 'spring-boot'],
    'spring': ['spring framework', 'spring mvc'],
    'hibernate': ['jpa'],
    'maven': [],
    'gradle': [],
    'kotlin': [],
    'microservices': ['microservice', 'micro services'],
    'mockito': [],
    'quarkus': [],
    'j2ee': ['jee', 'java ee', 'jakarta ee'],
    'multithreading': ['multi-threading', 'concurrency'],
  },
  ios: {
    'swift': [],
    'swiftui': ['swift ui'],
    'uikit': [],
    'objective-c': ['objective c', 'objc'],
    'xcode': [],
    'core data': ['coredata'],
    'ios': [],
    'android': [],
    'react native': ['react-native'],
    'flutter': ['dart'],
    'xctest': ['xcuitest'],
    'firebase': [],
    'app store connect': ['testflight'],
    'cocoapods': ['swift package manager', 'spm'],
    'mvvm': [],
  },
  python: {
    'python': ['python3'],
    'django': [],
    'flask': [],
    'fastapi': [],
    'pandas': [],
    'numpy': [],
    'celery': [],
    'machine learning': ['ml'],
    'pytorch': [],
    'tensorflow': [],
    'llm': ['llms', 'large language models', 'generative ai', 'genai'],
    'sqlalchemy': [],
    'airflow': ['apache airflow'],
    'pyspark': ['spark', 'apache spark'],
    'scikit-learn': ['sklearn', 'scikit learn'],
  },
  qa: {
    'selenium': [],
    'cypress': [],
    'playwright': [],
    'appium': [],
    'jest': [],
    'junit': [],
    'testng': [],
    'pytest': [],
    'test automation': ['automation testing', 'automated testing'],
    'manual testing': [],
    'api testing': ['postman'],
    'performance testing': ['jmeter', 'load testing'],
    'cucumber': ['bdd', 'gherkin'],
    'rest assured': ['restassured', 'rest-assured'],
    'jira': [],
    'regression testing': [],
  },
  devops: {
    'aws': ['amazon web services', 'ec2', 's3', 'lambda'],
    'gcp': ['google cloud'],
    'azure': [],
    'docker': [],
    'kubernetes': ['k8s', 'eks', 'gke', 'aks'],
    'terraform': [],
    'ansible': [],
    'ci/cd': ['cicd', 'ci cd', 'continuous integration'],
    'jenkins': [],
    'github actions': [],
    'linux': ['unix', 'bash', 'shell scripting'],
    'prometheus': ['grafana'],
    'helm': [],
    'argo cd': ['argocd'],
    'nginx': [],
    'datadog': [],
    'cloudformation': ['aws cdk'],
  },
  data: {
    'sql': [],
    'postgresql': ['postgres', 'psql'],
    'mysql': [],
    'mongodb': ['mongo', 'mongoose'],
    'redis': [],
    'elasticsearch': ['elastic search', 'opensearch'],
    'kafka': ['apache kafka'],
    'rabbitmq': [],
    'dynamodb': [],
    'git': ['github', 'gitlab', 'bitbucket'],
    'system design': ['distributed systems'],
  },
  other: {
    'golang': [],
    'rust': [],
    'c++': ['cpp'],
    'c#': ['.net', 'dotnet', 'asp.net'],
    'php': ['laravel'],
    'ruby': ['rails', 'ruby on rails'],
  },
};

const ALIASES = new Map<string, string>();
for (const group of Object.values(GROUPS)) {
  for (const [canonical, aliases] of Object.entries(group)) {
    ALIASES.set(canonical, canonical);
    for (const alias of aliases) ALIASES.set(alias, canonical);
  }
}

// Longest first, so "spring boot" wins over "spring" and "react native" over "react".
const PATTERNS = [...ALIASES.keys()]
  .sort((a, b) => b.length - a.length)
  .map((term) => ({
    term,
    re: new RegExp(`(?<![\\w.+#-])${term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '[\\s-]?')}(?![\\w+#]|\\.\\w)`, 'gi'),
  }));

export function canonicalSkill(skill: string): string {
  const key = skill.toLowerCase().trim();
  return ALIASES.get(key) ?? key;
}

// Known skills named in a posting, in canonical spelling, most mentioned
// first, ties in the order they first appear.
export function extractSkills(text: string): string[] {
  const found = new Map<string, { count: number; first: number }>();
  let rest = text;
  for (const { term, re } of PATTERNS) {
    const canonical = ALIASES.get(term)!;
    for (const m of rest.matchAll(re)) {
      const entry = found.get(canonical) ?? { count: 0, first: m.index };
      found.set(canonical, { count: entry.count + 1, first: Math.min(entry.first, m.index) });
    }
    // Blank the matches so "spring boot" is not counted again as "spring".
    rest = rest.replace(re, (m) => ' '.repeat(m.length));
  }
  return [...found.entries()].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first).map(([skill]) => skill);
}
