下载neovide-cursor.rebuilt.js，或直接复制代码自己找个文件保存。      
VSCode安装Custom CSS and JS loader插件，       
向settings.json添加配置:        
             
"vscode_custom_css.imports": [                      
    "file:///C:/path/to/your/neovide-cursor.rebuilt.js"               
]                       
            
然后ctrl+shift+p执行Enable Custom CSS and JS后重启VSCode即可                
修改配置的话保存修改后重新执行Enable Custom CSS and JS或Reload Custom CSS and JS就行                    

neovide-cursor.rebuilt.js（⭐）：gpt astra重构后的，性能更快，动效减少了一点。        
neovide-cursor.optimized.js：gpt astra基于原版优化，性能稍微提升，动效完整保留。
